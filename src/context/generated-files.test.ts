import { describe, expect, it } from 'vitest'
import { generatedFiles } from './generated-files.js'

const FILES = [
  'api.pb.go',
  'svc/api.pb.go',
  'svc/deep/api.pb.go',
  'gen/client.ts',
  'gen/nested/model.ts',
  'src/gen/client.ts',
  'src/index.ts',
]

describe('generatedFiles', () => {
  it('matches a pattern without a slash against the file name at any depth', () => {
    expect(generatedFiles('*.pb.go linguist-generated', FILES)).toEqual([
      'api.pb.go',
      'svc/api.pb.go',
      'svc/deep/api.pb.go',
    ])
  })

  it('anchors a pattern with a slash at the root, with ** crossing folders', () => {
    expect(generatedFiles('gen/** linguist-generated', FILES)).toEqual([
      'gen/client.ts',
      'gen/nested/model.ts',
    ])
    expect(generatedFiles('/svc/*.pb.go linguist-generated', FILES)).toEqual(['svc/api.pb.go'])
    expect(generatedFiles('**/gen/*.ts linguist-generated', FILES)).toEqual([
      'gen/client.ts',
      'src/gen/client.ts',
    ])
  })

  it('takes =true as set and -, ! or =false as unset, the later line winning', () => {
    const text = [
      'gen/** linguist-generated=true',
      'gen/nested/** -linguist-generated',
      '*.pb.go linguist-generated',
      'svc/** linguist-generated=false',
      'src/** linguist-generated',
      'src/index.ts !linguist-generated',
    ].join('\n')

    expect(generatedFiles(text, FILES)).toEqual(['api.pb.go', 'gen/client.ts', 'src/gen/client.ts'])
  })

  it('skips comments, other attributes, folder patterns and lines without the attribute', () => {
    const text = [
      '# gen/** linguist-generated',
      '',
      'gen/ linguist-generated',
      '*.ts text eol=lf',
      'src/index.ts linguist-vendored',
    ].join('\n')

    expect(generatedFiles(text, FILES)).toEqual([])
  })

  it('leaves a later line that does not mention the attribute without effect', () => {
    expect(generatedFiles('gen/** linguist-generated\ngen/client.ts text eol=lf', FILES)).toEqual([
      'gen/client.ts',
      'gen/nested/model.ts',
    ])
  })
})
