import type { Node } from 'web-tree-sitter'
import type { Collector } from '../walk.js'

export function walkPython(root: Node, c: Collector): void {
  visitChildren(root)

  function visitChildren(node: Node): void {
    for (const child of node.namedChildren) if (child) visit(child)
  }

  function visit(node: Node): void {
    switch (node.type) {
      case 'import_statement':
        return importStatement(node)
      case 'import_from_statement':
        return importFrom(node)
      case 'function_definition':
        return declareFunction(node)
      case 'class_definition':
        return declareClass(node)
      case 'assignment':
        return assignment(node)
      case 'call':
        return call(node)
      default:
        return visitChildren(node)
    }
  }

  function declareFunction(node: Node): void {
    const owner = c.ownerKind()
    const name = node.childForFieldName('name')?.text ?? ''
    const body = node.childForFieldName('body')
    const kind = owner === 'class' ? 'method' : 'function'
    const key = c.symbol(kind, name, node, { exported: isPublic(name, owner), body })
    c.within(key, () => {
      for (const parameter of node.childForFieldName('parameters')?.namedChildren ?? []) {
        if (!parameter) continue
        const parameterName = parameterNameOf(parameter)
        if (parameterName !== undefined) c.symbol('parameter', parameterName, parameter)
        visit(parameter)
      }
      if (body) visit(body)
    })
  }

  function declareClass(node: Node): void {
    const name = node.childForFieldName('name')?.text ?? ''
    const body = node.childForFieldName('body')
    const key = c.symbol('class', name, node, { exported: isPublic(name, c.ownerKind()), body })
    for (const base of node.childForFieldName('superclasses')?.namedChildren ?? []) {
      if (base && base.type !== 'keyword_argument') c.heritage(key, base.text, 'extends')
    }
    c.within(key, () => {
      if (body) visit(body)
    })
  }

  function assignment(node: Node): void {
    const owner = c.ownerKind()
    if (owner === undefined || owner === 'class') {
      for (const name of targetNames(node.childForFieldName('left'))) {
        c.symbol('variable', name, node, { exported: isPublic(name, owner) })
      }
    }
    const right = node.childForFieldName('right')
    if (right) visit(right)
  }

  function call(node: Node): void {
    const fn = node.childForFieldName('function')
    if (fn?.type === 'identifier') c.call(fn.text, node)
    else if (fn?.type === 'attribute') {
      c.call(fn.childForFieldName('attribute')?.text ?? '', node, fn.childForFieldName('object'))
    } else c.call('(anonymous)', node)
    visitChildren(node)
  }

  function importStatement(node: Node): void {
    for (const name of node.childrenForFieldName('name')) {
      if (!name) continue
      if (name.type === 'aliased_import') {
        const module = name.childForFieldName('name')?.text ?? ''
        c.import(module, 'namespace', node, name.childForFieldName('alias')?.text ?? module)
      } else c.import(name.text, 'namespace', node, name.text)
    }
  }

  function importFrom(node: Node): void {
    const module = node.childForFieldName('module_name')?.text ?? ''
    if (node.namedChildren.some((child) => child?.type === 'wildcard_import')) {
      c.import(module, 'namespace', node, '*')
      return
    }
    for (const name of node.childrenForFieldName('name')) {
      if (!name) continue
      if (name.type === 'aliased_import') {
        c.import(
          module,
          'named',
          node,
          name.childForFieldName('name')?.text ?? '',
          name.childForFieldName('alias')?.text,
        )
      } else c.import(module, 'named', node, name.text)
    }
  }

  function isPublic(name: string, owner: string | undefined): boolean {
    if (name.startsWith('_')) return false
    if (owner === undefined) return true
    const key = c.owner()
    return owner === 'class' && key !== undefined && (c.map.symbols[key]?.exported ?? false)
  }
}

function parameterNameOf(node: Node): string | undefined {
  switch (node.type) {
    case 'identifier':
      return node.text
    case 'default_parameter':
    case 'typed_default_parameter':
      return node.childForFieldName('name')?.text
    case 'typed_parameter':
    case 'list_splat_pattern':
    case 'dictionary_splat_pattern':
      return node.namedChildren.find((child) => child?.type === 'identifier')?.text
    default:
      return undefined
  }
}

function targetNames(node: Node | null): string[] {
  if (!node) return []
  if (node.type === 'identifier') return [node.text]
  if (node.type === 'pattern_list' || node.type === 'tuple_pattern') {
    return node.namedChildren.flatMap((child) => targetNames(child))
  }
  return []
}
