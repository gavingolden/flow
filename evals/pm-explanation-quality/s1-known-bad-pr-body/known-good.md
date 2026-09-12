## Why

Some checks need to judge a single piece of writing on its own merits —
nothing else. If that kind of check can also poke around the rest of the
codebase, follow a link, or make an edit while it works, its verdict is no
longer trustworthy: you can't tell whether it judged the text you handed it
or something it went and found on its own. Until now, every automated check
built this way simply inherited whatever access its caller already had, so
there was no way to run one that was provably blind to everything except
the one thing it was asked to look at.

## User-facing changes

A check can now run with zero access to anything but the single file it's
handed — no reading elsewhere, no writing, no side effects — so its
judgment is guaranteed to rest only on that file's contents. This is
opt-in: every check that doesn't ask for the restriction keeps working
exactly as it does today, with the same access it always had. The
restriction is requested with a new `--tools` flag; passing it an empty
value is what locks the check down completely.
