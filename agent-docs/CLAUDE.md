# Agent documentation

This file is the only one at the top level. Everything else goes in one of these
places:

- `handoffs/` holds live, unfinished state in dated files. A handoff points to
  the code and commits instead of copying them. Delete a handoff once its work
  lands.
- An idea we tried and declined gets a sentence, with the number, at the code
  that would try it again. There is no file of rejected ideas.
- What a session did, and in which commits, is in the git history.

Cite a doc by its path, so that a grep finds every citation when the doc moves.
Split a doc that says "State as of \<date\>" into the places above.
