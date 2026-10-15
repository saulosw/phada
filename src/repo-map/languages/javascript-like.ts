import type { Node } from 'web-tree-sitter'
import type { Collector } from '../walk.js'
import { stringValue } from '../walk.js'

const FUNCTION_VALUES: ReadonlySet<string> = new Set([
  'arrow_function',
  'function_expression',
  'function',
  'generator_function',
])

export function walkJavaScriptLike(root: Node, c: Collector): void {
  visitChildren(root)
  for (const item of c.map.exports) {
    if (item.local === undefined || item.module !== undefined) continue
    for (const symbol of c.map.symbols) {
      if (symbol.parent === undefined && symbol.name === item.local) symbol.exported = true
    }
  }

  function visitChildren(node: Node): void {
    for (const child of node.namedChildren) if (child) visit(child)
  }

  function visit(node: Node, exported = false): void {
    switch (node.type) {
      case 'import_statement':
        return importStatement(node)
      case 'export_statement':
        return exportStatement(node)
      case 'function_declaration':
      case 'generator_function_declaration':
      case 'function_signature':
        return declareFunction(node, exported)
      case 'class_declaration':
      case 'abstract_class_declaration':
        return declareClass(node, exported)
      case 'interface_declaration':
        return declareInterface(node, exported)
      case 'type_alias_declaration': {
        const key = c.symbol('type', nameOf(node), node, { exported })
        const value = node.childForFieldName('value')
        if (value) c.within(key, () => visit(value))
        return
      }
      case 'enum_declaration':
        c.symbol('enum', nameOf(node), node, { exported })
        return
      case 'method_definition':
      case 'method_signature':
      case 'abstract_method_signature':
        return declareMethod(node)
      case 'public_field_definition':
      case 'field_definition':
        return declareField(node)
      case 'lexical_declaration':
      case 'variable_declaration':
        if (c.owner() !== undefined) return visitChildren(node)
        for (const child of node.namedChildren) {
          if (child?.type === 'variable_declarator') declarator(child, exported)
        }
        return
      case 'call_expression':
        return call(node)
      case 'new_expression':
        return construct(node)
      case 'identifier':
      case 'type_identifier':
      case 'shorthand_property_identifier':
        c.reference(node.text, node)
        return
      case 'member_expression':
        return member(node)
      case 'nested_type_identifier':
        return nestedType(node)
      default:
        return visitChildren(node)
    }
  }

  function declareFunction(node: Node, exported: boolean): void {
    const body = node.childForFieldName('body')
    const key = c.symbol('function', nameOf(node), node, { exported, body })
    c.within(key, () => {
      parameters(node)
      returnType(node)
      if (body) visit(body)
    })
  }

  function declareClass(node: Node, exported: boolean): void {
    const body = node.childForFieldName('body')
    const key = c.symbol('class', nameOf(node), node, { exported, body })
    for (const heritage of node.namedChildren) {
      if (heritage?.type !== 'class_heritage') continue
      const clauses = heritage.namedChildren.filter((child) => child !== null)
      const typed = clauses.some(
        (clause) => clause.type === 'extends_clause' || clause.type === 'implements_clause',
      )
      if (!typed) {
        for (const value of clauses) c.heritage(key, typeName(value), 'extends')
        continue
      }
      for (const clause of clauses) {
        if (clause.type === 'extends_clause') {
          for (const value of clause.childrenForFieldName('value')) {
            if (value) c.heritage(key, typeName(value), 'extends')
          }
        } else if (clause.type === 'implements_clause') {
          for (const type of clause.namedChildren) {
            if (type) c.heritage(key, typeName(type), 'implements')
          }
        }
      }
    }
    c.within(key, () => {
      for (const child of node.namedChildren) {
        if (child && child.type !== 'class_heritage') visit(child)
      }
    })
  }

  function declareInterface(node: Node, exported: boolean): void {
    const body = node.childForFieldName('body')
    const key = c.symbol('interface', nameOf(node), node, { exported, body })
    for (const clause of node.namedChildren) {
      if (clause?.type !== 'extends_type_clause') continue
      for (const type of clause.namedChildren) {
        if (type) c.heritage(key, typeName(type), 'extends')
      }
    }
    c.within(key, () => {
      if (body) visitChildren(body)
    })
  }

  function declareMethod(node: Node): void {
    const owner = c.ownerKind()
    if (owner !== 'class' && owner !== 'interface') return visitChildren(node)
    const body = node.childForFieldName('body')
    const key = c.symbol('method', nameOf(node), node, { exported: ownerExported(), body })
    c.within(key, () => {
      parameters(node)
      returnType(node)
      if (body) visit(body)
    })
  }

  function declareField(node: Node): void {
    if (c.ownerKind() === 'class') {
      c.symbol('variable', nameOf(node), node, { exported: ownerExported() })
    }
    const type = node.childForFieldName('type')
    if (type) visit(type)
    const value = node.childForFieldName('value')
    if (value) visit(value)
  }

  function declarator(node: Node, exported: boolean): void {
    const name = node.childForFieldName('name')
    const value = node.childForFieldName('value')
    if (value && isRequire(value)) return requireImport(value, name)
    if (name?.type === 'identifier' && value && FUNCTION_VALUES.has(value.type)) {
      const body = value.childForFieldName('body')
      const key = c.symbol('function', name.text, node, { exported, body })
      c.within(key, () => {
        parameters(value)
        returnType(value)
        if (body) visit(body)
      })
      return
    }
    for (const variable of patternNames(name)) c.symbol('variable', variable, node, { exported })
    const type = node.childForFieldName('type')
    if (type) visit(type)
    if (value) visit(value)
  }

  function returnType(fn: Node): void {
    const type = fn.childForFieldName('return_type')
    if (type) visit(type)
  }

  function parameters(fn: Node): void {
    const list = fn.childForFieldName('parameters')
    if (list === null) {
      const single = fn.childForFieldName('parameter')
      if (single) for (const name of patternNames(single)) c.symbol('parameter', name, single)
      return
    }
    for (const parameter of list.namedChildren) {
      if (!parameter) continue
      const pattern =
        parameter.type === 'required_parameter' || parameter.type === 'optional_parameter'
          ? parameter.childForFieldName('pattern')
          : parameter
      for (const name of patternNames(pattern)) c.symbol('parameter', name, parameter)
      visit(parameter)
    }
  }

  function importStatement(node: Node): void {
    const module = stringValue(node.childForFieldName('source'))
    if (module === undefined) return
    const clause = node.namedChildren.find((child) => child?.type === 'import_clause')
    if (!clause) {
      c.import(module, 'side-effect', node)
      return
    }
    for (const part of clause.namedChildren) {
      if (!part) continue
      if (part.type === 'identifier') c.import(module, 'default', node, part.text)
      if (part.type === 'namespace_import') {
        c.import(module, 'namespace', node, part.namedChildren[0]?.text ?? '*')
      }
      if (part.type === 'named_imports') {
        for (const specifier of part.namedChildren) {
          if (specifier?.type !== 'import_specifier') continue
          const name = specifier.childForFieldName('name')?.text ?? ''
          c.import(module, 'named', node, name, specifier.childForFieldName('alias')?.text)
        }
      }
    }
  }

  function exportStatement(node: Node): void {
    const declaration = node.childForFieldName('declaration')
    const module = stringValue(node.childForFieldName('source'))
    const isDefault = node.children.some((child) => child?.type === 'default')
    if (declaration) {
      const before = c.map.symbols.length
      visit(declaration, true)
      for (const symbol of c.map.symbols.slice(before)) {
        if (symbol.parent !== undefined || symbol.kind === 'parameter') continue
        if (isDefault) c.export('default', node, symbol.name)
        else c.export(symbol.name, node)
      }
      return
    }
    const clause = node.namedChildren.find((child) => child?.type === 'export_clause')
    if (clause) {
      for (const specifier of clause.namedChildren) {
        if (specifier?.type !== 'export_specifier') continue
        const name = specifier.childForFieldName('name')?.text ?? ''
        const alias = specifier.childForFieldName('alias')?.text
        if (module !== undefined) c.import(module, 'named', node, name, alias)
        c.export(alias ?? name, node, name, module)
      }
      return
    }
    if (module !== undefined) {
      const namespace = node.namedChildren.find((child) => child?.type === 'namespace_export')
      c.import(module, 'namespace', node, '*')
      c.export(namespace?.namedChildren[0]?.text ?? '*', node, undefined, module)
      return
    }
    const value = node.childForFieldName('value')
    if (value) {
      c.export('default', node, value.type === 'identifier' ? value.text : undefined)
      visit(value)
    }
  }

  function call(node: Node): void {
    if (isRequire(node)) return requireImport(node)
    const fn = node.childForFieldName('function')
    const { name, qualifier } = callee(fn)
    c.call(name, node, qualifier)
    visitCallee(fn)
    for (const child of node.namedChildren) if (child && child.id !== fn?.id) visit(child)
  }

  function construct(node: Node): void {
    const fn = node.childForFieldName('constructor')
    const { name, qualifier } = callee(fn)
    c.call(name, node, qualifier, true)
    visitCallee(fn)
    for (const child of node.namedChildren) if (child && child.id !== fn?.id) visit(child)
  }

  function visitCallee(fn: Node | null): void {
    if (fn === null || fn.type === 'identifier') return
    if (fn.type !== 'member_expression') return visit(fn)
    const object = fn.childForFieldName('object')
    if (object && object.type !== 'identifier') visit(object)
  }

  function member(node: Node): void {
    const object = node.childForFieldName('object')
    const property = node.childForFieldName('property')
    if (object?.type === 'identifier' && property) {
      c.reference(property.text, node, object.text)
      return
    }
    if (object) visit(object)
  }

  function nestedType(node: Node): void {
    const module = node.childForFieldName('module')
    const name = node.childForFieldName('name')
    if (module?.type === 'identifier' && name) c.reference(name.text, node, module.text)
  }

  function requireImport(node: Node, binding?: Node | null): void {
    const module = stringValue(node.childForFieldName('arguments')?.namedChildren[0])
    if (module === undefined) return
    if (!binding) return c.import(module, 'require', node)
    if (binding.type === 'identifier') return c.import(module, 'require', node, binding.text)
    for (const part of binding.namedChildren) {
      if (part?.type === 'shorthand_property_identifier_pattern') {
        c.import(module, 'require', node, part.text)
      } else if (part?.type === 'pair_pattern') {
        const key = part.childForFieldName('key')?.text ?? ''
        c.import(module, 'require', node, key, patternNames(part.childForFieldName('value'))[0])
      }
    }
  }

  function ownerExported(): boolean {
    const owner = c.owner()
    return owner === undefined ? false : (c.map.symbols[owner]?.exported ?? false)
  }
}

function callee(node: Node | null): { name: string; qualifier?: Node | null } {
  if (!node) return { name: '(anonymous)' }
  switch (node.type) {
    case 'identifier':
    case 'super':
    case 'import':
      return { name: node.text }
    case 'member_expression':
      return {
        name: node.childForFieldName('property')?.text ?? '(anonymous)',
        qualifier: node.childForFieldName('object'),
      }
    default:
      return { name: '(anonymous)' }
  }
}

function isRequire(node: Node): boolean {
  if (node.type !== 'call_expression') return false
  const fn = node.childForFieldName('function')
  const first = node.childForFieldName('arguments')?.namedChildren[0]
  return fn?.type === 'identifier' && fn.text === 'require' && first?.type === 'string'
}

function nameOf(node: Node): string {
  return node.childForFieldName('name')?.text ?? 'default'
}

function typeName(node: Node): string {
  return node.text.replace(/<[\s\S]*$/, '').trim()
}

function patternNames(node: Node | null | undefined): string[] {
  if (!node) return []
  switch (node.type) {
    case 'identifier':
    case 'shorthand_property_identifier_pattern':
      return [node.text]
    case 'assignment_pattern':
    case 'object_assignment_pattern':
      return patternNames(node.childForFieldName('left'))
    case 'pair_pattern':
      return patternNames(node.childForFieldName('value'))
    case 'rest_pattern':
      return patternNames(node.namedChildren[0])
    case 'object_pattern':
    case 'array_pattern':
      return node.namedChildren.flatMap((child) => patternNames(child))
    default:
      return []
  }
}
