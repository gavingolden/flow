# Scripted simulation of the tmux tree view — mirrors the README's tmux
# section. It never invokes the real `flow`: hidden shell functions shadow
# `flow` and `tmux`, run everything on a private `tmux -L flow-demo` server
# under a throwaway HOME, and seed invented pipelines. The tree view itself
# is the real docs/tmux-tree.conf, loaded the way the README tells you to.
# Render with: env -u TMUX -u TMUX_PANE -u FLOW_SLUG vhs docs/demo/tmux.tape

Output docs/demo/tmux.gif

Set Shell "bash"
Set Theme "Catppuccin Mocha"
Set FontSize 16
Set Width 1100
Set Height 640
Set Padding 20
Set TypingSpeed 40ms

Hide
Type@1ms `unset TMUX TMUX_PANE FLOW_SLUG; R=$PWD; export HOME=$(mktemp -d); mkdir -p $HOME/code; ln -s $R $HOME/code/flow; PS1='$ '; export TERM=xterm-256color`
Enter
Type@1ms `tmux() { command tmux -L flow-demo "$@"; }; tmux kill-server 2>/dev/null`
Enter
Type@1ms `o() { tmux set-option -w -t flow:$1 @flow-$2 "$3"; }`
Enter
Type@1ms `seed() { o $1 slug $1; o $1 repo $2; o $1 phase $3; o $1 phase-short $4; [ -n "$5" ] && o $1 pr $5; [ -n "$6" ] && o $1 epic $6; tmux set-option -p -t flow:$1 @flow-kind $7; }`
Enter
Type@1ms `mkwin() { tmux new-window -d -t flow: -n $1 "echo '[$4] $2: $1'; exec sleep 100000"; seed "$@"; }`
Enter
Type@1ms `flow() { case "$1 $2" in "config launcher") echo "launcher: tmux";; "feature create") s=$(echo "$3" | tr ' ' '-'); mkwin $s acme-api starting start "" "" feature; printf 'flow feature create: created — attach with \x60flow attach %s\x60\n' $s;; "attach "*) tmux attach -t flow;; esac; }`
Enter
Type@1ms `tmux -f /dev/null new-session -d -s flow -n scratch -x 140 -y 34 "exec sleep 100000"`
Enter
Type@1ms `mkwin add-csv-export acme-api implementing impl "" "" feature; mkwin fix-oauth-redirect web-app plan-pending-review "plan?" "" "" feature; mkwin billing-rework acme-api implementing impl 118 billing-epic epic-run; mkwin rate-limit-api acme-api gated gated 131 "" feature; mkwin tidy-readme web-app merged merged 127 "" feature`
Enter
Type@1ms `t() { tmux rename-window -t flow:$1 "$2"; }; t add-csv-export 'CSV export'; t fix-oauth-redirect 'OAuth redirect'; t billing-rework 'Billing rework'; t rate-limit-api 'API rate limits'; t tidy-readme 'README tidy'; tmux kill-window -t flow:scratch; tmux move-window -r -t flow:; tmux set-option -g status-left-length 20; tmux set-option -g status-right ''`
Enter
Type "clear"
Enter
Show

Type "echo 'source-file ~/code/flow/docs/tmux-tree.conf' >> ~/.tmux.conf"
Sleep 600ms
Enter
Sleep 800ms
Type "tmux source-file ~/.tmux.conf"
Sleep 600ms
Enter
Sleep 800ms
Type "flow config launcher set tmux"
Sleep 600ms
Enter
Sleep 1s
Type `flow feature create "add dark mode"`
Sleep 600ms
Enter
Sleep 1s
Type `flow feature create "fix login timeout"`
Sleep 600ms
Enter
Sleep 1500ms
Type "flow attach"
Sleep 600ms
Enter
Sleep 2s
Ctrl+B
Type "w"
Sleep 2500ms
Down
Sleep 700ms
Down
Sleep 700ms
Down
Sleep 700ms
Down
Sleep 3s

Hide
Ctrl+B
Type "d"
Sleep 500ms
Type@1ms `tmux kill-server 2>/dev/null; rm -rf $HOME`
Enter
Sleep 500ms
