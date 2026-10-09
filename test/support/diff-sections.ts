export const MODIFIED =
  'diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n'
export const DELETED =
  'diff --git a/old.ts b/old.ts\ndeleted file mode 100644\nindex 1..0\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n'
export const RENAMED =
  'diff --git a/x.ts b/y.ts\nsimilarity index 100%\nrename from x.ts\nrename to y.ts\n'
export const BINARY =
  'diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n'

export function modifiedFile(path: string): string {
  return MODIFIED.replaceAll('src/a.ts', path)
}
