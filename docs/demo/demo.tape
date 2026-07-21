# Scripted simulation of a flow pipeline run — mirrors the README hero
# transcript. It never invokes the real `flow`: a hidden shell function
# shadows the command and prints contrived, illustrative output.
# Render with: vhs docs/demo/demo.tape

Output docs/demo/demo.gif

Set Shell "bash"
Set Theme "Catppuccin Mocha"
Set FontSize 16
Set Width 1000
Set Height 600
Set Padding 20
Set TypingSpeed 40ms

Hide
Type "flow() { printf '\n[plan] feature detected — drafting plan, pausing for approval\n  Plan: add a CSV exporter behind a flag, with tests.\n'; sleep 1; printf '  approve? > approved\n'; sleep 1; printf '\n[implement] worktree ready, applying edits, running verify ... ok\n'; sleep 1; printf '[ci]       PR #142 opened — waiting for checks ....... green\n'; sleep 1; printf '[review]   multi-agent review + Copilot ... 2 findings fixed\n'; sleep 1; printf '[gate]     Test Steps all checked -> auto-merge\n'; sleep 1; printf '\nMERGED\n'; }"
Enter
Type "clear"
Enter
Show

Type 'flow feature create "add CSV export"'
Sleep 800ms
Enter
Sleep 8s
Sleep 2s
