# Renders the still screenshot behind the README's tmux tree image. It never
# runs the real `flow`: it works on a private `tmux -L flow-demo` server under
# a throwaway HOME and seeds invented pipelines. The tree view itself is the
# real docs/tmux-tree.conf, loaded the way the README tells you to.
# Render via: ./docs/demo/render-tmux-tree.ts (adds the numbered markers)

Output docs/demo/.render/throwaway.gif
Set Shell "bash"
Set Theme "Catppuccin Mocha"
Set FontSize 16
Set Width 1100
Set Height 300
Set Padding 20
Hide
Type@1ms `unset TMUX TMUX_PANE FLOW_SLUG; R="$PWD"; D=$(mktemp -d) || exit; export HOME="$D"; mkdir -p "$HOME/code"; ln -s "$R" "$HOME/code/flow"; PS1='$ '; export TERM=xterm-256color`
Enter
Type@1ms `tmux() { command tmux -L flow-demo "$@"; }; tmux kill-server 2>/dev/null`
Enter
Type@1ms `o() { tmux set-option -w -t flow:$1 @flow-$2 "$3"; }`
Enter
Type@1ms `seed() { o $1 slug $1; o $1 repo $2; o $1 phase $3; o $1 phase-short $4; [ -n "$5" ] && o $1 pr $5; tmux set-option -p -t flow:$1 @flow-kind feature; }`
Enter
Type@1ms `mkwin() { tmux new-window -d -t flow: -n $1 "echo '[$3] $2: $1'; exec sleep 100000"; seed "$@"; }`
Enter
Type@1ms `tmux -f /dev/null new-session -d -s flow -n scratch -x 106 -y 26 "exec sleep 100000"`
Enter
Type@1ms `mkwin new-logo web-app merged merged 11; mkwin fix-typo web-app gated gated 12; mkwin add-csv-export api plan-pending-review "plan?"; mkwin add-search web-app implementing impl; mkwin add-dark-mode web-app starting start; mkwin fix-login-bug api starting start`
Enter
Type@1ms `t() { tmux rename-window -t flow:$1 "$2"; }; t new-logo 'New logo'; t fix-typo 'Typo fix'; t add-csv-export 'CSV export'; t add-search 'Search'; tmux kill-window -t flow:scratch; tmux move-window -r -t flow:; tmux select-window -t flow:5; tmux set-option -g status-right ''`
Enter
Type "echo 'source-file ~/code/flow/docs/tmux-tree.conf' >> ~/.tmux.conf"
Enter
Type "tmux source-file ~/.tmux.conf"
Enter
Type "clear"
Enter
Type@1ms "tmux attach -t flow"
Enter
Sleep 1s
Ctrl+B
Type "w"
Sleep 1500ms
Show
Sleep 200ms
Screenshot docs/demo/.render/tmux-tree.png
Sleep 500ms
Ctrl+B
Type "d"
Sleep 300ms
Type@1ms `tmux kill-server 2>/dev/null; rm -rf "${D:?}"`
Enter
Sleep 300ms
