Output docs/demo/review.gif
Output docs/demo/review.txt

Set Shell bash
Set FontFamily "DejaVu Sans Mono"
Set FontSize 15
Set Width 1200
Set Height 820
Set Padding 20
Set TypingSpeed 45ms
Set Theme "Catppuccin Mocha"

Hide
Type "cd /demo && export PS1='$ ' && clear"
Enter
Show

Type "phada review saulosw/phada-demo#1 --dry-run > review.md"
Sleep 500ms
Enter
Wait+Screen@60s /Saved as run/
Sleep 3s
Type "more review.md"
Sleep 500ms
Enter
Sleep 5s
Space
Sleep 5s
Space
Sleep 5s
