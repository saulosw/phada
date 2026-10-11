import type { Node } from 'web-tree-sitter'
import type { Collector } from '../walk.js'

const EXPORTED = /^\p{Lu}/u

export function walkGo(root: Node, c: Collector): void {
  visitChildren(root)
  for (const symbol of c.map.symbols) {
    if (symbol.kind !== 'method' || symbol.container === undefined) continue
    const owner = c.map.symbols.find(
      (candidate) =>
        candidate.parent === undefined &&
        candidate.kind !== 'variable' &&
        candidate.kind !== 'function' &&
        candidate.name === symbol.container,
    )
    if (owner === undefined) continue
    symbol.parent = owner.key
    delete symbol.container
  }

  function visitChildren(node: Node): void {
    for (const child of node.namedChildren) if (child) visit(child)
  }

  function visit(node: Node): void {
    switch (node.type) {
      case 'import_spec':
        return importSpec(node)
      case 'function_declaration':
        return declareFunction(node, 'function')
      case 'method_declaration':
        return declareFunction(node, 'method')
      case 'type_spec':
        return declareType(node)
      case 'const_spec':
      case 'var_spec':
        if (c.owner() === undefined) {
          for (const name of node.childrenForFieldName('name')) {
            if (name) c.symbol('variable', name.text, node, { exported: EXPORTED.test(name.text) })
          }
        }
        return visitChildren(node)
      case 'call_expression':
        return call(node)
      default:
        return visitChildren(node)
    }
  }

  function declareFunction(node: Node, kind: 'function' | 'method'): void {
    const name = node.childForFieldName('name')?.text ?? ''
    const body = node.childForFieldName('body')
    const receiver = node.childForFieldName('receiver')
    const container = receiver ? receiverType(receiver) : undefined
    const key = c.symbol(kind, name, node, {
      exported: EXPORTED.test(name),
      body,
      ...(container === undefined ? {} : { container }),
    })
    c.within(key, () => {
      if (receiver) parameters(receiver)
      parameters(node.childForFieldName('parameters'))
      if (body) visit(body)
    })
  }

  function declareType(node: Node): void {
    const name = node.childForFieldName('name')?.text ?? ''
    const type = node.childForFieldName('type')
    const exported = EXPORTED.test(name)
    if (type?.type === 'struct_type') {
      const key = c.symbol('struct', name, node, { exported })
      for (const field of type.descendantsOfType('field_declaration')) {
        if (field && field.childForFieldName('name') === null) {
          const embedded = field.childForFieldName('type')
          if (embedded) c.heritage(key, embedded.text.replace(/^\*/, ''), 'embeds')
        }
      }
      return
    }
    if (type?.type === 'interface_type') {
      const key = c.symbol('interface', name, node, { exported })
      c.within(key, () => {
        for (const element of type.namedChildren) {
          if (element?.type === 'type_elem') c.heritage(key, element.text, 'embeds')
          if (element?.type === 'method_elem') {
            const method = element.childForFieldName('name')?.text ?? ''
            const methodKey = c.symbol('method', method, element, {
              exported: EXPORTED.test(method),
            })
            c.within(methodKey, () => parameters(element.childForFieldName('parameters')))
          }
        }
      })
      return
    }
    c.symbol('type', name, node, { exported })
  }

  function parameters(list: Node | null): void {
    for (const declaration of list?.namedChildren ?? []) {
      if (!declaration) continue
      for (const name of declaration.childrenForFieldName('name')) {
        if (name) c.symbol('parameter', name.text, declaration)
      }
    }
  }

  function call(node: Node): void {
    const fn = node.childForFieldName('function')
    if (fn?.type === 'identifier') c.call(fn.text, node)
    else if (fn?.type === 'selector_expression') {
      c.call(fn.childForFieldName('field')?.text ?? '', node, fn.childForFieldName('operand'))
    } else c.call('(anonymous)', node)
    visitChildren(node)
  }

  function importSpec(node: Node): void {
    const path = node.childForFieldName('path')?.text.replace(/^["`]|["`]$/g, '') ?? ''
    const alias = node.childForFieldName('name')?.text
    c.import(path, 'namespace', node, alias ?? path.slice(path.lastIndexOf('/') + 1))
  }
}

function receiverType(receiver: Node): string | undefined {
  const type = receiver.namedChildren[0]?.childForFieldName('type')
  return type?.text.replace(/^\*/, '').replace(/\[[\s\S]*$/, '')
}
