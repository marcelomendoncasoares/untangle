# UX proposal v17: start from the chain map, end in the code

> Draft v17, 2026-10-16. Extends the v13 grouping rules and v16 history design (see "History").
> Starting point: [00-original-prompt.md](00-original-prompt.md).
> Working prototype on serverpod_offline_sync #168: https://claude.ai/artifact/MEkRBmhVGgqBPUB5QYAFVB (version 15,
> with the "Calmer by default" proposal that `untangle`'s page now follows).
> Prototype sources: [prototype/](prototype/).
> Test runs of these rules on #157, #166, #162 and four Serverpod PRs: [02-test-runs.md](02-test-runs.md).

## Requirements

From the review of v1:
- **A view of the diff, not a report.** The same input always gives the same view, and no
  model writes anything.
- **No analysis written for one PR,** and no inferred trust levels.
- **Must have:** syntax highlighting, go to definition, search.

From the review of v2:
- **Chains of related changes are the main navigation,** and each chain has a graph. The
  view starts from the chain and ends in the code. A files panel stays as the secondary
  view.
- **Marking something reviewed never hides code.** Reviewed code stays visible and muted.
  Its diff is hidden by default, with a button to show it again.
- **Only hunks can be collapsed.**
- **Opening a "same edit" shows the whole edit,** including multi-line ones.

From the review of v3:
- **A hunk folds on its own** when its last change is marked reviewed.
- **Renames and same changes belong in chains,** for example `userId → spaceId`,
  `spaceIdFor` and `withCurrentNodeHlc → withUserClock`.
- **Syntax highlighting** must be clearly visible.
- **The palette is dark,** black and dark grey instead of blue.
- **Each chain shows its total diff.**
- **Clicking a graph node focuses on it and filters the code** instead of jumping to it. (Since
  v22, with the chips gone, a click goes to the member, as theirs did, and Shift-click filters.)
- **Chains form a hierarchy,** shown as a chain-of-chains view.
- **Folding one hunk must never fold another.**

From the review of v4:
- **Removed code links the same way as added code,** with its own language server for go
  to definition and linking.
- **The chain map is the first screen.**

From the review of v5:
- **Generated code links back to its model** (`.spy.yaml`).
- **Measure the cost** of the second language server.

From the review of v6:
- **"Same change" triggers too much.** One doc-comment edit showed as "the same change
  ×5", a lone `(` or `!` was a same change, and one rewrite carried up to five badges.

From the review of v7:
- **The first version is a web page,** not a VS Code extension, so it runs anywhere,
  including Orca's built-in browser.

From the review of v8:
- **A changed usage previews inside the peek.** Clicking it shows its code there instead
  of leaving the view; clicking it again goes to it.
- **Usage snippets are syntax highlighted.**

From the review of v9 and the test runs ([02-test-runs.md](02-test-runs.md)):
- **Fix every problem the runs on #157, #166 and #162 found.**

From the review of v10:
- **Changes that override the same method join one chain** (Q6).

From the review of v11:
- **Adopt the proposed answers to Q1–Q5.**

## Decisions (answers to the v2 questions)

1. **Same edit** = the same tree-sitter change. For example, one token replaced by
   another. Since v7, overlapping runs are one edit and punctuation alone never counts.
2. **Rebase conflicts** go back to unreviewed. A syntax-aware merge such as
   [mergiraf](https://mergiraf.org) runs first to resolve the simple ones.
3. **Snapshots live locally first.**
4. **A whole chain can be marked reviewed at once.**
5. **No `reviewedWith`.** Generated files are not reviewed, but they can be peeked for
   reference.
6. **Language servers on both sides.** This revises the v2 answer: removed lines get go
   to definition and link into chains like added lines.
7. **The diff layout is choosable,** unified by default.
8. **Where it runs:** a local web app first, open in any browser. A VS Code extension can
   wrap it later.
9. **Language servers:** one server with both checkouts as workspace folders, so go to
   definition stays live on both sides (about 850 MB on #168).
10. **Server language:** TypeScript on Node, for now.
11. **Overrides:** changed methods that override the same method join one chain.
12. **Member cohesion:** only for changes no other rule links. A chain shows the rest of its
    members folded, as context.
13. **Model adapters:** one per generator, built in and switched on by what the repository
    contains; `.review.yaml` can turn one off, add generated patterns or declare a mapping.
14. **Chain order:** by level, never by review progress, with a "next unreviewed" action.
15. **Large graphs:** introduced declarations are whole reading units; existing code stays
    one node per changed member, with existing test cases grouped by file. "+N more" only
    when a level is still too busy.
16. **Same change across declarations:** syntax only; the group view shows the declaration
    each place resolves to, and each can be marked on its own.
17. **Names in strings:** a string that looks like a name links like one, beyond what the
    language server sees.
18. **The CLI is `untangle`,** used like px0: `untangle [flags] [directory | pr-url]`.
    Serving the review comes first.

## Rules

### Changes

1. An atomic change block is a run of changed lines in a hunk, split where a declaration starts:
   - each top-level declaration (consecutive directives count as one);
   - each member of a class, mixin, extension or enum;
   - each `test(...)`, `group(...)`, `setUp...` or `tearDown...` call.
   A unit starts at its doc comments and annotations. Members written right under each
   other, with no blank line, stay together. A block with removed and added lines keeps its
   removed lines with the added lines they were diffed against. Blank lines are never a block
   of their own: blank lines before a unit go with it, and a block's mark sits on its first line
   that isn't blank.
2. **Reading units.** A fully introduced declaration is read in source order as one change:
   a class, mixin, enum, extension, type alias, function, method, top-level binding or
   configured YAML model. A class includes its constructor, fields and methods. This applies
   to new declarations inside existing files too. Fully added `test(...)` and `testWidgets(...)`
   calls are complete scenarios, identified by source position and labeled with the whole
   title, including adjacent string literals.
   - Changed test setup is grouped by its enclosing `group(...)` scope. Nested scenarios
     inherit enclosing setup; sibling groups retain separate context.
   - Existing declarations retain their smaller change blocks. Rewriting all their lines
     does not make them introduced declarations; moved code keeps its move representation.
   - Reading units sit above the original blocks and edits. Their IDs, saved review marks,
     refresh behavior and commit lenses remain intact.
   - Counts, navigation and Space operate on reading units. Gutter marks still allow an
     individual block to be reviewed. The explicit same-change view retains individual places.
   - Adjacent introduced declarations that share an indivisible atomic block stay together.
3. **Moved code.** A removed unit and an added unit with the same full name and kind, or
   the same short name and at least half their tokens alike, are one moved declaration.
   - Its change is the diff between the two bodies. Only the tokens that diff changed count
     as changed, for same changes and for chains.
   - The removed copy is shown as one line pointing at the new place, and its old usages
     link to the moved copy.
   - A move with no changes needs no review.

### Chains

1. Each changed line's identifiers are resolved with a language server:
   - added lines on the PR head, plus the called function of every changed argument
     list, even when its name sits above the hunk;
   - removed lines on the comparison's old side, in its own checkout.
2. A changed token on one change that resolves to a declaration on a changed line of
   another change links the two changes, on either side.
   - A renamed or moved declaration is one declaration, so its old and new usages link
     to it.
   - Chains rooted at a removed declaration are named with "−".
3. **A name that now means something else counts as changed.** A token whose text stayed
   (an argument label, say) but whose definition differs between the two sides (by file,
   name and enclosing member) links like a changed token.
4. **Calls follow signatures.** A call whose argument list changed, to a function whose
   signature changed:
   - a changed positional argument joins the parameter in the same position, when that
     parameter changed (a named argument already resolves to its parameter);
   - with no changed parameter, the call links to the function.
5. **Parameters pass a chain on.** Union-find runs over changes: a changed parameter joins
   its declaration with every change that uses it. A local variable does so only within its
   own member, and a brand-new function's parameters don't (calls link to the function).
6. **A changed existing function, method, field or type starts a chain:** its declaration plus the
   changes that use it.
   - A member's chain and the ripple of its own parameters merge.
   - A field and the constructor parameter that sets it (`this.field`) are one declaration:
     the field's chain is the constructor's chain.
   - Merging uses the declaration's file and source identity, never just its displayed name.
     Two private helpers called `_money` in different libraries remain separate.
7. **Tests follow their calls.** From each declaration a changed test uses, in production
   code or in an unchanged test helper, the language server's outgoing calls are followed
   breadth first, up to 3 levels inside the repository. The test links to the first changed
   function on each path, whether its signature or its body changed.
   - A test is a `*_test.dart` file, or a file under a `test*/` or `integration_test/`
     directory.
8. **A same-change group that names an identifier is a chain** for existing code. Introduced
   declarations keep ownership of their blocks; same-change badges remain available there.
9. **Member cohesion.** A change that no other rule links joins the chains of its member.
   Changes that already belong to a chain stay out of other chains.
   - In test files, the member is the enclosing `test(...)` or `testWidgets(...)`, keyed by
     its call position. A `group(...)` is setup, not a test case.
   - A comment-only change belongs to the declaration it documents, unless the block holds
     that declaration itself.
10. **Reading units and chains are different.**
    - A complete introduced declaration is one reading unit, not automatically one chain.
      Self-contained new code, including connected declarations within one file, stays in
      the file review. New-code chains connect multiple whole units across files.
    - Resolved dependencies establish ownership. A new dependency with one production
      consumer joins that consumer's component. Mutually dependent new declarations form
      one component before ownership is evaluated. Shared dependencies do not combine
      their otherwise independent consumers. No file name, PR metadata or size target
      determines membership.
    - Validation is independent of implementation ownership. Scenarios follow resolved
      references through their scoped setup and helpers, stopping at each changed
      implementation. Multiple tests can validate one API, and one test can validate
      multiple APIs. An unchanged call on a changed assertion line still counts.
    - Implementation units have one owner. A complete test or helper can appear in each
      implementation chain it validates, retaining the same block IDs and review marks.
      Shared test context does not merge production chains or their families. Traversal
      follows individual scenarios and helpers, never a same-change group's membership.
    - Units are never split between chains. Units without a resolved connection remain
      available by file, with the same saved marks and navigation.
    - A removed type's member chains still fold into that type, scoped to its file.
11. **Overrides.** The language server says what each changed method overrides
    (`dart/textDocument/super`).
    - Changed methods that override the same method, a framework's say, join one chain.
    - An override of a changed method links to it.
    - The members of `Object` (`toString`, `==`, `hashCode`) are left out.
12. **Imports, parts and docs.**
    These attachments apply to existing-code chains; they never split an introduced
    reading unit. Unattached imports and docs remain reviewable by file.
    - A new import of a file in the repository joins the chains that, in the same file, use
      declarations from the imported file. A `package:` import counts when the package is in
      the repository; with two pubspecs of the same name, it resolves to the one that has
      the file.
    - An import prefix (`as p`) starts no chain: its import joins the chains that use the
      prefix.
    - A `part` directive joins the chains that have changes in its part file.
    - A Markdown change that names a chain's member or declaration in backticks joins that
      chain.
13. **Names in strings.** A string on a changed line, or a backticked span in Markdown, that
    looks like a name: 4 to 80 characters of letters, digits, `_`, `.` or `-`, with a capital
    after the first letter, an underscore, a dot, a dash or a digit.
    - It links to the changed declaration with that name, when there is one.
    - Otherwise, when two or more changes introduce it and one of them is code, they are a
      chain named after the string (`“tail_runner_logs”`).
    - Strings with `$` interpolation are left out, and so is a string in more than 15
      changes.
14. **Generated code leads back to what it was generated from,** through an adapter per
    generator. Each switches on by what the repository contains, on either side of the diff:
    - **Serverpod** (`*.spy.yaml`, `*.spy.yml`, `*.spy`): generated `Table`, `Include` and `Repository` classes map
      to the model class, a field to the model field, and a relation's `…Id` column to the
      relation. A doc-comment change in the model belongs to the field below it.
    - **Generated part files** (`*.g.dart`, `*.freezed.dart`: freezed, json_serializable,
      built_value and the like): `_$User`, `$UserCopyWith` and `_User` map to `User` in the
      library that owns the part, and their members to `User`'s members or constructor
      parameters.
    - **Protobuf** (`*.proto`): a generated message class maps to its message, and a getter
      or its `has`/`clear`/`ensure` accessor to the field in snake_case.
    - **`.review.yaml`** at the repository root can add `generated:` patterns, turn an
      adapter on or off (`adapters:`), and declare YAML-model mappings of its own (`models:`,
      with `generated`, `source` and `classSuffixes`).
15. A chain needs at least two reading units and two graph nodes. New-code chains also
    require resolved connections across files; being a complete class or sharing a file
    is not enough. A repeated change collapsed into one graph node remains available in
    the same-change group view. Chains with exactly the same changes are one chain.
    Changes in no chain are listed by file.
16. **Name:** the best declaration inside the chain: what remains before what was removed,
    members and types before parameters and locals, public before private, then the most
    used. In a ripple, the top parameter comes first: the one whose callers don't pass it on
    from a parameter of their own.
17. **Graph:**
    - one node per introduced reading unit, before any same-change aggregation;
    - one node per member;
    - nodes that are all the same change, 3 or more times, collapse into one;
    - the tests of one test file are one node;
    - arrows go from a change to what it uses;
    - layers are the distance from the root.
18. **Totals:** each chain shows its total diff (+/−) and how many changes are reviewed.

### Chain of chains

- A chain's **core** is its whole introduced declaration, otherwise the changes of its
  root's member, or all its changes when it has no root.
- **Chain A uses chain B** when A's core uses a function, method, field or type in B's
  core.
- **Depth** is the longest path from a chain that nothing uses, ignoring back edges of
  cycles.
- **Families** are chains connected by "uses" or by shared changes.
  Introduced test suites and test helpers retain their dependency links but do not connect
  otherwise independent production families through shared test infrastructure.
- **The chain map** lays a family out by depth:
  - it draws only direct dependencies (a transitive reduction);
  - arrows that skip levels are faint;
  - one dashed line joins each group of chains connected by "uses" to the chain it shares
    the most changes with.

### Chains by commit

Chains follow the commits rather than the code's structure alone, unless `-chains structure`
asks for the code's (or the commits can't be replayed). A commit is the one boundary its author
declared; the review collapses its back-and-forths.

1. **Provenance.** The review's first-parent commits are replayed from where the branch
   started (`src/provenance.ts`). Every line carries its **origin**, the commit that first
   changed that spot, and every commit that changed it after.
   - An edited line keeps its origin: a hunk's removed and added lines pair up when at least
     half their tokens match.
   - A line only reformatted (whitespace, line breaks, a trailing comma) keeps its history.
   - A line moved within a commit keeps its history when a neighbour moved with it, or it is
     40 characters or longer; a moved line of the base is credited to the commit that moved it.
   - A merge from the base's branch starts nothing.
2. **Follow-ups.** A commit **revises** another when it edits, moves or removes lines that
   commit started. A commit that revised one chain, and changed more of its lines than it
   started of its own, is a **follow-up**: it joins that chain. Any other commit starts a
   chain with what it started: one that **builds on** the chain it revised, or that
   **revises** several.
3. **Blocks.** A block goes to the chain that started most of its lines (the older one on a
   tie), and a whole new declaration goes with it. A test group's setup is no declaration:
   each of its blocks goes on its own.
   - A block no commit made goes with the nearest change of its file, the one after it on a
     tie: the addition that replaces it. Git's diff of the whole review can pair lines the
     commits never touched; a closing brace pushed down shows as removed there and added
     further on.
   - A file where no commit of the branch wrote a line stays outside chains.
4. **One chain per commit,** however large: the commit is the unit its author declared.
   Splitting a large one by the structural rules brought their arbitrary boundaries back,
   with a new test file divided between steps.
5. **Renames** keep their own chains, apart from the commits': a same change whose every edit
   swaps one name for another (`spaceId → userId`), wherever it sits in the syntax. A block
   that is nothing but renames stays out of its commit's chain. Other same changes, a call
   added in three places say, read in their commit's chain.
6. **Links.** A change that uses a function, method, field or type another chain changes
   links to it, and the changes stay where the rules above put them. The chain's graph shows
   the declaration in a dotted box. A note under the member that uses it names the chain that
   changes it (a commit's before a rename's): "changed in" one read before, "changes later in"
   one read after. The name, or the box, shows the declaration's change in place, read only,
   with a way to open its chain. The `userId → spaceId` rename of offline_sync #168 links
   `spaceIdFor`, added by the first commit.
   - The linked change is not shown first or last in the chain. In commit order, most links
     point to a chain already read (110 of offline_sync #168's 119, 75 of #5866's 83), so it
     would repeat it; a test commit can use twenty or more. It matters for the links to later
     chains, about half of them in a messy history, which the note names as such.
7. **Display.** A chain is named after the commit that started it and opens with its
   message. The sidebar lists the chains in commit order, then the renames. The chain map
   shows each commit's chain after the chains it builds on or whose lines it changes. Each
   test file's new tests and their setup are one node, read whole, and a chain's root is
   production code before tests.
8. **Who wrote a chain.** Its commits are shown, not told: a thin bar, pinned under the
   header, has a part for each commit that last wrote some of its changed lines,
   oldest first, as wide as its share, the chain's own commits (its first and follow-ups)
   lighter. A chain one commit wrote has no bar.
   - Hovering a part dims the lines that commit didn't write; clicking it makes the commit the
     lens, as History's chips do.
   - Beside it: how many commits; "Also in N chains", the other chains the chain's own
     commits wrote lines in, each opening that chain through the commit, with its changes
     there as History's chips count them; and "Commit details", History's card in place.
   - The Commits tab follows the chain open: its commits say in how many of its changes they
     wrote, its own commits are ringed, the others fade. Hovering a commit there dims the
     lines it didn't write, and going from chain to chain keeps the tab.
   - No chips for the commits: they compete with the members' chips, crowd the chains with
     many commits, where by commit helps most, and "Changes from" already picks commits.
   - Every number counts blame's lines, as the lens does; provenance decides only the
     families and the map's order. Blame ignores whitespace, so a commit that re-indents a
     line leaves it with the commit that wrote it.

### Tests as sentences

A test's group and test titles join into the sentence it asserts ("Given …, when …, then …."),
and reviewing a test starts there: the code is there to confirm it.

1. **The outline.** A test file's `test`, `testWidgets` and `group` calls on both sides, and any
   call with a string first argument that holds them (Serverpod's `withServerpod`), nested as
   they nest (`analysis/outline.js`). A test's sentence is the titles from its outermost group
   down to it, joined as written. A wrapper whose title isn't a clause (`withServerpod('[Clocks]',
   …)`) is a label: it heads its tests and stays out of their sentences.
2. **Matching.** By position, as the analyzer has it: a call whose line stayed is the same call;
   then a call with the same title that moved, under the same group when it can be; then a
   rewritten call line, among its siblings in order (a new title on the same call); then a test
   that reads the same sentence in new groups.
3. **Compared as sentences.** A test is new, **reworded** (a title on its path changed: renaming
   a Given rewords every test under it, touched or not), **regrouped** (the same words in new
   groups, commas and spaces aside) or unchanged; a group is new or renamed. A removed call is
   listed with the sentences it held.
4. **Its own lines.** Each call carries the blocks in its range, in its own lines (without its
   title and the calls under it: a group's setup) and in its title. Lines that only close
   brackets don't count: the diff pairs closing braces as it likes, and an unchanged group would
   own a stray `});` that a test's mark then covered.
5. **In a chain.** A chain reads its test members as their files' outlines, after its code: what
   it changed in what they assert, with every group that completes each sentence (dimmed when
   unchanged, with the commit that wrote it when another chain did). A group the chain wrote or
   renamed brings the tests under it, whichever commit wrote them.
   - Unchanged siblings fold under "+N unchanged whens"; code edited under sentences that stay
     (setup, bodies) follows the outline, and changes outside every call (imports, helpers)
     come last, both open: they're the chain's code.
   - A row opens its code in place, with the lines it removed beside the ones it has: a test
     its whole body, a group its own lines with its calls folded to their titles. Blank lines
     between folded calls don't show. ↗ opens the file at the call.
   - A rewording marks the words that changed. A title with two clauses ("when …, then ….") is
     one row.
   - A same change keeps its places; a rename chain reads as before.
6. **Marks.** A test's mark covers its body; a group's, its setup and everything under it; a
   file's, on its line, every change in it (in a chain or a commit, the ones there). The pill, j,
   k and Space go through the rows with lines left to review: a test's body, a group's own lines
   and title.
7. **The Tests view,** under History in the sidebar: every sentence the review's tests add,
   reword, regroup or remove, file by file, each with the commit (or chain) that wrote it, which
   opens that chain at the row. Filters keep one kind, each with its count (one with none is
   off); Sentences shows each test as its whole
   sentence, a renamed group's changed words on the first test it heads. Files that change no
   sentence come last, in one row that opens (open already when they're all there is); a file's
   name opens its diff.
8. **Pinned groups.** Over a test file's code, in any view, and over an outline, the groups of
   the line at the top of the view whose own lines have scrolled away stay pinned under the
   header, with the test's title when the line is in its body.
9. **What a row says besides its sentence.** A Given or a when that sets nothing up itself (no
   `setUp`, `setUpAll` or variable with a value that its calls share) has a red dot. Hovering a
   row shows, beside the commit that wrote it, a test's expect calls (`expect` and `expectLater`
   called by name, not in comments), muted, and the diff's lines in the call (+X −Y; in a chain,
   the chain's). Their room is kept, so nothing moves under the pointer. ↗ is drawn with strokes
   that stay whole at any zoom.
10. **What's reviewed folds away,** in the Tests view, as reviewed hunks do. A test marked
    reviewed settles, then folds into a line, "✓ 3 tests reviewed", that holds the reviewed rows
    next to it and shows them again on a click. A group folds only once everything under it is
    reviewed; until then it stays, its mark shows a dash, and its title mutes once its own lines
    are reviewed. A file's mark reviews it whole, and a file reviewed whole folds to its line
    ("✓ 12 tests reviewed"), which opens on a click with every row shown. Space carries on from
    the line a test folded into.

On offline_sync #168, 3,460 changed test lines fit in 137 rows: 70 new sentences, 6 reworded, 3
regrouped and 1 removed, in 8 of its 43 test files. The other 35 change no sentence: 134 calls
with edited setup or bodies. 16 of the new sentences had a Given or when their chain didn't show.
424 of its 425 Givens and whens set up in `setUp` or `setUpAll`; the other declares its state
in the group's body.

### Same change

1. Change blocks are the runs of `-`/`+` lines in a hunk.
2. Their tokens are diffed with an LCS. Brackets match by nesting depth, and words inside
   comments and strings never match code.
3. For Dart, tree-sitter describes each run of changed tokens:
   - **one token replaced by another,** with its role: a reference, a declaration name
     (the language server resolves it to itself), a named argument, a type or a keyword;
   - **otherwise, the smallest run of complete sibling nodes** that covers the run:
     inserted, removed or replaced, keyed by node types and normalized text.
4. An edit is a piece of syntax, not a token run:
   - **runs whose syntax nodes overlap are one edit,** so five changed words in one doc
     comment line are one edit;
   - **a run of punctuation only** (brackets, commas, `!`, quotes, an empty `///`) joins
     an edit of its innermost statement or declaration, and doesn't change that edit's
     description.
5. Edits with the same description form a group. Groups that always occur in the same
   blocks merge. Punctuation alone never forms a group.
   - In languages without a grammar (YAML, Markdown), an edit is described by its whole
     words as written, so `0.0.10 → 0.0.11` is not "10 → 11".
6. A group instance shows each edit's rows, extended to its whole syntax nodes, with one
   line of context. Small changes are shown whole.

### Reviewed snapshot

- Your review is a local git branch: the base plus every change you marked reviewed. The
  viewer diffs it against the PR head, so a new push only brings back what changed since
  you looked.
- On a rebase, the snapshot is replayed onto the new base with a syntax-aware 3-way
  merge (mergiraf or similar). Regions that still conflict go back to unreviewed.

### Generated files

- A file is generated when `.gitattributes` marks it `linguist-generated`, when an active
  adapter's patterns match it (Serverpod's `generated/` and `migrations/`, `*.g.dart`,
  `*.freezed.dart`, `*.pb.dart` and the like), or when it matches `generated` patterns in
  `.review.yaml`.
- Generated files are never reviewed or counted. They are listed apart and can be opened
  read-only.

### Display

- **Reviewed changes stay visible.** By default their diff is hidden, so the new code
  reads as muted context. Pure deletions become a single "N removed lines, reviewed" row.
  "Show diff" restores the muted diff, either per change or for all changes.
- **Only hunks collapse, and they collapse automatically when their last change is
  reviewed.** The user can reopen them or collapse any hunk by hand. In a chain view,
  hunks over 150 lines start collapsed, with buttons that jump to the lines that belong
  to the chain.
- **Each view has its own hunks.** A chain section shows each change with 3 lines of
  context, merged when they touch. Folding a hunk in one place never folds another.
- **More of the file, as on GitHub.** The divider above a hunk (its first line and context, in
  grey) stands for the lines hidden above it. Clicking it shows 20 more, up from the hunk or down
  from the one before, or all of them when 20 or fewer are left; a divider after the last hunk
  shows the rest. A chain section grows the same way, across hunks and the lines between them.
  "Show the whole file" shows the whole file around the diff, read-only, with go to definition
  on every name.
- **Calmer by default.** Three surfaces (the ground, the sheet the code sits on, what floats over
  it) instead of borders; one accent, amber, for what's left to review; a check for what's done;
  blue for GitHub; Schibsted Grotesk for the interface and JetBrains Mono for code and names.
  Each view shows one action and a way to the next change; the rest waits on hover, in a menu,
  or on a key.
- **A view's header is one row:** a breadcrumb (Map / chain, Files / folder / file), what it
  holds, ↑ and ↓ for every change, a ⋯ menu (open in the editor, the whole file, side by side,
  the diffs of reviewed code, the minimap, a comment on the file, the chain map, uses and used
  by), and the view's one action. A file's chains are one control, "In 3 chains".
- **Back:** each view the page moves to is a step in the browser's history. Once the page has
  moved, an arrow before the breadcrumb ("Back to Tests") returns to the view before, scrolled
  where it was, with its sidebar tab; so do the browser's Back, Alt ← and a mouse's back button.
- **One gutter:** the review mark, muted until the pointer is on its line; one line number
  (the old one, in red, for a removed line); the sign. Same changes elsewhere and changed usages
  are grey notes at the line's end. A hunk's divider shows "Mark hunk reviewed" on hover.
- **Getting around:** the review pill (where you are among the view's changes to review, and
  "Mark and go to the next", Space), Jump to (Ctrl K: chains, files, threads, and declarations
  from the language server's workspace symbols), and keys (j, k, Space, Shift+Space, n, p, c,
  Esc; `?` lists them).
- **Motion:** what changes moves from where it was to where it goes, in 120 to 280 ms, easing
  out. A reviewed hunk's check fills, its diff settles and it folds into its divider while the
  code below glides up; lines shown from a divider open downward from it; a peek, or a commit's
  details, grows from where it was asked and folds back there when it closes; a test's code, or
  what an outline's fold holds, opens downward from its row and folds back into it; going to a
  change scrolls to it and pulses it; landing further down the page jumps, then glides over the
  last 120 px; another view fades in (from above, going back). With "reduce motion", all of it is
  instant.
- **Panels:** the sidebar resizes from its edge and hides (Ctrl B); a minimap at the right of the
  code shows the view small, with what's left to review in amber and threads in blue.
- **The Files tab is a folder tree,** folders first, with a folder that holds only one folder
  shown with it (`lib/src/mcp`), as VS Code compacts them.
- **The sidebar's tabs pin their views** at the top, over a line, while the list scrolls: the
  chain map, History and Tests above the chains; History, All changes and Since your review
  above the commits. Hovering a chain, a file, a folder or a commit shows the lines it adds and
  removes (+X −Y) in place of its count.
- **The top bar's dot** (the language server: green, starting, failed) reads the memory and CPU
  that untangle and its language server use together ("721 MB · 0.3%"), so a review's cost shows
  at a glance; hovering it lists each one's.
- **The pull request's comments, as on GitHub.** Threads show under their lines (a resolved one
  folds), with replies, reactions and suggestions. A Threads tab lists them, open ones first,
  with the conversation (description, comments, reviews). The **+** over a line starts a comment
  (drag it, or shift-click, for a range in the hunk): a single comment, or one kept in the pending review that
  "Finish your review" submits as a comment, an approval or a request for changes. A reviewed
  hunk doesn't fold while a conversation in it is open.
- **Refresh in place.** New commits on the pull request show as a banner with Refresh, as on
  GitHub. untangle builds the new review in the background, and the page reloads on the same
  view when it's ready.
- **While the review builds,** the page lists every step the build runs, in order, with their
  times: a check for what's done, a turning mark and what it's doing for the step that runs (the
  analyzer's files read, with a bar and about how long is left), "cached" for a step the cache
  spares, and what's to come. A bar under the title fills by each step's usual share, and
  through the analyzer by its files.
  - It hears of each change as it happens: untangle answers its question when the build moves on.
    New lines grow in, a finished step's check draws as its details fold, and the running step's
    ground glides to the next one.
  - It's 1,040 pixels wide, enough for a checkout's path on one line, and wraps a longer one at
    its slashes. Then the review replaces it.
- **A chain's graph hangs from the header** (v22), each member with what's left in it; there are
  no member chips. The header names the member being read and its place ("Reading `merge` · 4 of
  16"), beside the graph's button.
  - At the top of a chain the graph is open under the header, in the page. As the code scrolls
    it under the header, its last stretch shrinks toward the button, which pulses once it's gone;
    scrolling back plays it back. A chain shorter than the pane gets room after its end, so it
    can still scroll away, and a click on the button scrolls it away at once.
  - Anywhere else, hovering the button drops the graph over the code from the pinned header (a
    look: leaving the button and the graph lifts it), and a click keeps it down until a member's
    click, a click elsewhere, Esc or scrolling. `g` does what the click does.
  - It drops centered on the member being read, ringed in amber (in a "+N more" group, the
    group). Its drop and its fold are one animation played forward and back, so a fold midway
    goes back up from where it got to.
  - Clicking a member goes to its code and pulses it. Shift-click shows only that member's code
    and dims the unrelated ones, without scrolling, so the graph stays under the pointer; the
    names its arrows stand for show then, in the gaps between rows of nodes.
  - In a file whose changes are in chains, the button drops the graph of the chain of the line
    being read, with a tab for each of the file's chains, and a member's click opens that chain
    there.
- **The commits** (v15, decided in v16): a Commits tab in the sidebar draws them as a graph,
  newest on top; the head commit in the top bar opens it as a popover too ("Changes from": the
  presets, then a line per commit). A History view shows each with what it touched, its checks
  and its reviews from GitHub, and the commits a merge brought from the base under it; a
  commit clicked there opens its details under it, as Git Graph shows them: parents, author,
  committer, dates, message, and its files as a tree or a list, each opening with the commit
  as the lens. Picking a commit, a range, "Since your review" or a force-pushed head turns on a
  lens, named on the head commit in the top bar: lines outside it fade (nothing is hidden),
  counts and keys follow it, and under a commit's lens a mark covers that commit's lines, so a
  change is done when all its commits are. Blame over the pull request's commits attributes
  each changed line (whitespace ignored), and git log lists each commit's files, once per
  review (0.2 s on #5864, 0.7 s on #5630); "since" a head is a diff from it. The lanes follow
  VS Code's Source Control Graph (`scmHistory.ts`, MIT).
- **Chain order:** chains keep the map's order, by level and larger first. Reviewed chains
  stay in place, muted. Keys `n` and `p` walk the same order.
- **Test files in a chain:** a test file's tests are one node in the graph. A chain made only
  of one test file lists its tests by `group(...)` instead of drawing a graph.
- **The rest of a member:** a chain section folds the member's other changes, which belong to
  other chains ("3 more changes in this member, in other chains").
- **Same change by declaration:** the group view lists its places under the declaration each
  resolves to ("6 places · 6 declarations"), with marking per declaration.
- **Moved code:** the added copy shows "Moved from file:line" and the diff of the two
  bodies. Unchanged moved lines are tinted and long runs of them fold. The removed copy is
  one line, "N lines moved to file:line". Either file:line shows the other copy in a peek under
  the note first (where it went, or where it came from at the old side), its moved lines
  tinted, with "Go to it" to go there.
- **Peek:** the definition on top, the changed usages below. Clicking a usage shows its
  code in the peek, with the usage line marked; clicking it again, or "Go to it", opens
  it. "Back to definition" returns. Usage snippets are highlighted like the code. A name
  clicked inside a peek changes it in place (it stays when the name leads to what it already
  shows), and a click outside closes it.
  - While the language server looks a name up, or the file it's in loads, the peek is already as
    tall as its code will be, with lines drawn in grey where the code will go: it opens once and
    fills in place. An answer or a file that arrives redraws only the peek, easing its height when
    it changed, never the page around it. Closing, it folds away with its code where it was
    scrolled.
- **Dark palette** with VS Code Dark+-style syntax colors. Function names are told apart
  from other identifiers.
- **Unified by default, split on demand** from a view's ⋯ menu. Split pairs removed and added
  lines per change and wraps long lines.

## Historical numbers on #168 (v13 prototype)

| | vs main (e0598c1) | vs snapshot at 0540639 |
|---|---:|---:|
| Hand-written files with changes | 66 | 24 |
| Changes | 580 | 265 |
| Edits | 740 | 432 |
| Same-change groups | 33 | 16 |
| Changes with 2+ same-change badges (most on one) | 5 (2) | 1 (2) |
| Chains (across files / within a file) | 62 (39 / 23) | 50 (24 / 26) |
| Changes in a chain / not in a chain | 551 / 29 | 192 / 73 |
| Generated files (lines) | 21 (25,731) | 3 (42) |

Changes went up from 387 because each declaration and each test is now a change of its own.

- **Largest chain:** `OfflineSyncDatabase.mergeChanges`, with 253 changes in 45 files
  (+1,312 −372), drawn as 40 nodes. The 154 identical call-site edits are one node, and so
  are each test file's tests.
- **Removed declarations:** 8 chains start at one, such as
  `− OfflineSyncSpaceManager._cachedCurrentNode` with 7 changes.
- **Old-side language server:** it resolved 1,795 of 1,846 removed-line identifiers
  (main) and 1,223 of 1,246 (snapshot).
- **Model chains:**

  | Chain | Changes | Files |
  |---|---:|---:|
  | `− OfflineSyncSpace.currentNode` | 48 | 18 |
  | `CrdtNode.localUserUuid` | 22 | 11 |
  | `OfflineSyncSpace.lastHlc` | 9 | 6 |

- **Same change, v6 → v7:**

  | | v6 | v7 |
  |---|---:|---:|
  | Edits (vs main) | 822 | 549 |
  | Same-change groups | 53 | 25 |
  | Edits in a group | 395 | 258 |
  | Changes with 2+ badges | 25 | 5 |
  | Most badges on one change | 5 | 2 |
  | Badges in `sync_cached_clock_receive_test.dart` | 38 | 11 |

  Every group with an identifier survived whole: `spaceId → userId` (156, all at
  `mergeChanges` calls), `hlcManagerFor → spaceIdFor` (14), `nodeUuid → .nodeUuidFor(space)`
  (14). What went away was punctuation (`(` ×9, `!` ×6, `,` ×5, `}` ×4, `'` → `"` ×4, empty
  `///` ×8) and self-repeats (one doc-comment line counted 5 times).
- **Chain of chains:** the main family has 61 chains in 7 levels, 10 of them joined only by
  shared changes, with the model chains at the bottom. Tests use `mergeChanges`, which uses
  `transactionForUser`. That one uses the recorder's `getOrCreateUserNode` and the
  `userId → spaceId` group, which lead through `_initializeOnce` to the space manager's
  `getOrCreateUserNode`, and that one uses the model chains and the cache fields. One chain
  links to no other.
- **Member cohesion (Q1):** limiting it to changes no rule links keeps the same 550 changes in
  chains and shrinks the chains it used to inflate: `− OfflineSyncSpace.currentNode` 66 → 48,
  `_transactionAs` 54 → 38, and chain memberships 1,014 → 869.
- **Adapters (Q2):** `prototype/make_fixture.sh` builds a three-commit repo with a
  freezed-style part file and a protobuf message. Both new fields link to the code that
  reads them through the generated files (`User(email)`, `Account.billing_email`), and the
  third commit's `.review.yaml` turns protobuf off, so `.pb.dart` is reviewed as normal
  code.
- **Still outside a chain (29):**

  | Reason | Changes |
  |---|---:|
  | Comment-only edits of members in no chain | 12 |
  | Markdown or YAML naming nothing in a chain | 8 |
  | One-line Dart edits using only unchanged code | 9 |

## Cost of the language servers (measured on #168)

The web app runs one Dart analysis server with both checkouts as workspace folders.

- **Memory:** about 850 MB peak with both checkouts in one server, so the old side adds
  about 210 MB to the head's 640 MB. Two separate servers would need about 1.3 GB (the old
  side alone peaks at 690 MB). This duplicates memory only when an editor already has the
  PR head open.
- **Time:** the batch that builds chains took 106 s for the head side's 8,526 lookups and
  23 s for the old side's 1,846, about 12 ms per lookup with startup. After that, a click
  is one lookup.
- **Disk:** the old checkout is a git worktree sharing objects with the repo: 18 MB of
  source plus 76 KB of `.dart_tool`. Packages come from the shared pub cache (no new ones
  for this commit).
- **The batch runs once per pair of commits:** its answers are cached with the analysis
  (about 500 KB for the old side here), so reopening a review doesn't redo it. Only the
  page's live requests reach the server after that.

- **Tooling limit:** the YAML grammar from `tree-sitter-wasms` doesn't load with
  `web-tree-sitter` 0.25. The `.spy.yaml` and Markdown files fall back to plain token
  edits.

## Where it runs

**A local web app.** A small command-line tool, [`untangle`](../README.md), serves the
page on localhost. It runs git, tree-sitter and the language servers, and the page asks it
for everything else. Any browser can open it: Orca's, VS Code's Simple Browser, or a remote
machine's through a forwarded port. It works like px0: one command,
flags in Go's style, and the target is a directory or a pull request URL.

```
untangle [flags] [directory]   # the branch's pull request, found with gh (default: .)
untangle [flags] <pr-url>      # cloned into the cache first
```

| | Prototype page (static) | Served by `untangle` |
|---|---|---|
| Go to definition | Answered ahead of time for the identifiers in the diff (about 8,500 on the new side). A definition outside the diff opens as a snippet of up to 10 lines. | Asked live on click, anywhere: whole files, inside a peek, removed lines. |
| Files | Diff hunks only (a chain section grows within its hunk) | The whole file around its diff, and any file at either revision |
| Search | Changed lines | Changed lines, plus the repository at either revision (`git grep`) |
| Jump to (Ctrl K) | Chains, files | Chains, files, threads, and declarations from the language server |
| Highlighting | A regex tokenizer, with real rules for Dart and YAML only | [Shiki](https://shiki.style): VS Code's TextMate grammars and its Dark+ theme |
| Review marks | Browser storage | Commits on the reviewed-snapshot branch |
| GitHub comments | None | Read and written through `gh`, as the user: threads, replies, pending reviews, reviews |

- **The server:**
  - **Git:** diffs, files at either revision, and the reviewed-snapshot branch, with
    mergiraf on a rebase. It is plain git underneath, so git-tree-compare (full mode) or
    `git diff` can show what's left.
  - **Checkouts:** each side is a git worktree that shares objects with the repo (18 MB
    of source for #168), or an existing checkout of the same commit, such as an agent's
    worktree.
  - **Analysis:** the core from `prototype/analyze.js` (edits, same-change groups, chains
    and the chain map), cached per pair of commits.
  - **Language server:** one Dart analysis server with both checkouts as workspace
    folders. It answers the batch that builds chains, then the page's live requests. Like
    an editor, it only analyzes the packages of open files, and untangle opens the files
    it asks about: on #157, 2,444 lookups took 10 s instead of 123 s with the same answers.
  - **Stack:** TypeScript on Node, reusing this prototype, web-tree-sitter, Shiki and
    `vscode-jsonrpc`, the LSP layer VS Code is built on.
  - **Access:** localhost only, with a random token in the URL, as Jupyter does.
  - **Done when the page is:** each page (the startup page too) tells untangle when it opens and,
    with a beacon, when it closes. It also holds a WebSocket while it's open, since some browsers
    destroy a closed tab's page without letting it say so (Orca's): the socket drops with it, and
    that closes the page too. Once the last one has closed and none opens within 5 s (a reload),
    untangle answers the calls still pending (a mark saved as the page went) and stops. A page the
    browser freezes says it's asleep, since it may be discarded to save memory without a word, so
    untangle keeps serving that one. `-autoclose=false` keeps it serving until Ctrl+C.
- **Open in editor:** file headers and peeks link to the editor, `vscode://file/<path>:<line>`
  by default, or a command you configure.
- **Static export:** `untangle -export` writes the page as one HTML file with everything
  computed ahead, as this prototype is, for sharing a review read-only.
- **Later:**
  - **Editor extensions** that show the same page in a webview and add open in editor.
    Sapling's [Interactive Smartlog](https://sapling-scm.com/docs/addons/isl) works this
    way: `sl web` opens it in a browser, and Sapling's VS Code extension embeds it.
  - **Agents** can read the same JSON API the page uses: what's left, and which chain a
    change belongs to.

## Build order

Serving the review came first. Steps 2 and 3 are done in `untangle`, and step 1 is done
through the page.

1. **Snapshot (done, through the page):** marks are commits on a local branch,
   `untangle/pr-<number>`, the base plus every change marked reviewed. A rebase replays the
   branch with mergiraf, then git's line merge; what still conflicts goes back to unreviewed.
   git-tree-compare and `git diff` show what's left. No separate `mark` or `status` command
   yet.
2. **Analysis core (done):** tree-sitter edits, same-change groups, chains and the chain
   map from the language server, as in `prototype/analyze.js`, cached per pair of
   commits. untangle's pipeline gives the prototype's answers exactly, step by step, on
   the eight PRs ([02-test-runs.md](02-test-runs.md)).
3. **Local web app (done):** `untangle` serves the page with progress while it builds, go to
   definition asked live on both sides (whole files, peeks, removed lines), whole files at
   either side or outside the repository, repository search, Shiki highlighting, open in
   editor, marks on the snapshot branch, and generated diffs loaded on demand. `-export`
   writes the same page as one HTML file, for sharing a review read-only.
4. **Later:** a VS Code extension around the same page, the API for agents, sharing
   snapshots with teammates, and syncing GitHub's viewed checkboxes.

## Open questions

1. **Families and shared tests.** Chains that share changes are one family since v13. Most
   shared changes are tests that reach two chains, so on a large PR almost everything is one
   family: 61 of #168's 62 chains, and all 14 of #166's. The map shows each such join as one
   dashed line. Keep counting shared tests, or count only shared changes outside tests? That
   would leave #168 with 4 families, #166 with 5 and Serverpod #5471 with 10, and #5864's
   feature would stay one family.
   - *Suggestion:* keep them. The dashed lines say why chains are together, and every chain
     gets a place on a map; in v12, 15 of #168's chains were on none.

## History

- **v1:** each change was a decision or a consequence, folded under trust tiers. It came
  with analysis written by hand for #168.
  - Rejected: it reads like a report, the tiers are hard to make systematic, and it had
    no code navigation.
- **v2:** a deterministic viewer.
  - The left side of the diff became the reviewed snapshot.
  - It added token-level repeated edits, changed usages from the language server, and
    generated-file rules.
  - Feedback: navigate by chains with a graph, never hide reviewed code, collapse only
    hunks, and show whole edits.
- **v3:** chains as the main navigation, tree-sitter same changes, a graph per chain.
  - Feedback:
    - too many changes outside chains;
    - weak highlighting, and a blue look;
    - add chain totals;
    - focus on node click instead of jumping;
    - show a chain of chains;
    - fold hunks on review;
    - collapsing one hunk folded others.
- **v4:** the chain map, focus on node click, auto-folding hunks, dark palette.
  - Feedback: removed code should link the same way, with a language server of its own,
    and the map should be the first screen.
- **v5:** old-side language server, map first.
  - Feedback: link generated code to its YAML model, and measure the cost of the second
    server.
- **v6:** model links, measured cost of the second server.
  - Feedback: "same change" triggers too much.
- **v7:** stricter same change.
  - Feedback: make the first version a web page instead of a VS Code extension, so it
    runs anywhere, including Orca's browser.
- **v8:** a local web app instead of a VS Code extension.
  - Decided: one language server with both checkouts, and TypeScript for the server.
  - Feedback: preview a changed usage inside the peek, highlighted, and go to it on a
    second click.
- **v9:** usage previews in the peek.
  - Asked: how hard-coded is it to #168? The rules ran unchanged on #157, #166 and #162 and
    found seven problems ([02-test-runs.md](02-test-runs.md)).
  - Feedback: fix all of them.
- **v10:** the fixes, with the three PRs in the viewer.
  - Decided: overrides of the same method join one chain (Q6).
- **v11:** overrides as one chain.
  - Decided: Q1–Q5 as proposed (cohesion only for unlinked changes, adapters per generator,
    chain order by level, tests grouped by file in graphs, same change by syntax with
    declarations shown).
- **v12:** Q1–Q5 applied.
  - Asked: run the rules on four Serverpod PRs, a much larger repository. They found nine
    problems ([02-test-runs.md](02-test-runs.md)).
  - Feedback: fix all nine as proposed.
- **v13:** the nine fixes.
  - Asked: build the CLI, focused on serving the review, with px0's UX: a directory or a pull
    request URL, cloned into a temporary place. Named `untangle`; clones go to a cache, so the
    next pull request of the same repository only fetches.
  - Asked: the rest of the local web app (live go to definition, whole files, repository
    search, Shiki, open in editor, marks on the snapshot branch, `-export`). Done in
    `untangle`.
  - Asked: bands that show more of the file, as GitHub's; the file whole in the page,
    read-only, with go to definition, and a switch back to the changed chunks; VS Code's
    icons for a view's tools, with unified/split moved there; the Files tab as a tree. Done.
  - Asked: the pull request's comments from GitHub, to review without leaving the page (adding,
    showing, pending reviews, replies), through the local `gh` login rather than a token. Done,
    tested on a throwaway pull request of this repository.
  - Asked: drag to comment on several lines, and refresh to new commits without relaunching.
    Done.
  - Asked: suggestions for `@` (people, teams) and `#` (issues, pull requests) in comments. Done;
    image uploads aren't possible through GitHub's API.
  - Asked: a cleaner interface (colors, borders, spacing, fonts, placement, navigation) and
    motion that makes it smoother, drawn first in the prototype page ("Calmer by default").
    Then: build all of it, with resizable panels, a minimap, and a review mark muted until
    hovered. Done.
  - Asked: more room in the sidebar and the top bar, guides that close on their last row, the
    marks' panel as a note with a Reset button, the chain's members pinned, a peek that closes on
    a click outside and changes in place from inside. Done.
  - Asked: the graph shown by default, behind an icon in the header instead of the menu (and no
    chain map in the menu), arrows' names only for the node clicked, lighter arrows, filtering
    from the graph without scrolling, and the language server's process id on its own line.
    Done.
- **v15:** four places for a graph of the commits (a Commits tab, "Changes from" on the head
  commit, a History view, a range strip), drawn on #5630's history, and the existing components
  that could draw it.
  - Decided (v16): the Commits tab drives it, the head commit opens it, the History view is for
    reading the history; force pushes in; lines outside a lens fade; under a commit's lens a mark
    covers that commit's lines; newest on top; main's commits listed in the History view; dots
    show state; lanes from VS Code's code. Later: a commit's files and lines in the History view.
  - Asked: build it as designed. Done.
  - Asked: a commit's details in the History view, as Git Graph shows them; the lens named only
    in the top bar, without the chip in the view's header; and B's popover on the head commit.
    Done.

- **v17:** introduced declarations are complete reading units above stable atomic edits.
  - The grouping pass could fragment new classes and merge unrelated consumers through
    shared helpers or displayed names. Added declaration ownership, source-scoped identities,
    complete test titles, and a baseline/candidate cohesion replay over the validation corpus.
  - Validation and remaining limits: [02-test-runs.md](02-test-runs.md).
- **v18:** chains by commit (`-chains history`), after structural boundaries kept feeling
  arbitrary: new code split too much, tests hard to follow, and no reason shown for a chain.
  - Grouping by the commits that touched the same lines collapses most histories into one
    chain: one sweeping commit (docs, test conventions, formatting) joins every intent. On
    the 13 public PRs, 7 of the 12 with several commits ended in one group holding 93% or
    more of their lines. Grouping by the commit that started each line, with follow-ups
    folded in, gave 3 to 13 chains, the largest holding 30% to 62% (one dominant first
    commit aside).
  - Rules: [Chains by commit](#chains-by-commit).
- **v19:** one chain per commit, after reviewing branches by commit: a new test file split
  between a large commit's steps, the setup of several new test files gathered into one "same
  change" chain, and a removed brace outside every chain.
  - No steps: a commit's chain holds all of it. Only renames stay apart. A change no commit
    made joins the nearest change of its file.
  - Asked: keep linking a change to the functions it uses that other commits change, without
    moving them. Done: dotted nodes and notes that open the other chain.
  - Asked: show the linked change in place rather than first or last in the chain, and say
    whether its chain comes before or after. Done: the change in a peek.
  - Validation: [02-test-runs.md](02-test-runs.md#2026-10-16-one-chain-per-commit).
- **v20:** a chain's commits shown rather than told. Its note's sentences ("Changed later by",
  "Changes the lines of") were slow to scan, named only later commits, and counted lines no
  view could show.
  - Six ways were drawn on offline_sync #168: chips for the commits, a bar of who wrote the
    lines, "Changes from" narrowed to the chain, History's rows in the chain, a Commits tab
    that follows the chain, and notes on lines from other commits.
  - Asked: no chips, since they compete with the members' chips and crowd long chains, and
    the top bar already picks commits. Keep the bar, pinned with the members, with "Also in
    N chains" and History's card; make the Commits tab follow the chain; and dim, while a
    commit is hovered, the lines it didn't write. Done: [Who wrote a chain](#chains-by-commit).
  - Found: blame credited re-indented lines to the commit that re-indented them. On #168,
    a test refactor wrote 100 of the 112 lines of another commit's chain by plain blame; with
    whitespace ignored, that chain's commit keeps 64 and the refactor 12. Blame now ignores
    whitespace, for the lens too.

- **v21:** tests as sentences. A test's titles join into the sentence it asserts, but the diff
  buries it in code and cuts it: a then added to an existing Given showed without that Given.
  - Five places were drawn on offline_sync #168: outlines in the chain, bodies folded with the
    groups pinned in the code, a Tests tab, a Tests view, and sentence headers on the hunks.
  - Asked: the outline in the chain and the Tests view, with the pinned groups when a test opens
    in its file, and the proposed answers (code under unchanged sentences after the outline,
    unchanged siblings folded, changed words marked in place, a two-clause title as one row, a
    group's mark covering everything under it). Done: [Tests as sentences](#tests-as-sentences).
  - Found: the diff pairs closing braces freely, so an unchanged Given could own a stray `});`
    and show a setup change; lines that only close brackets don't count as a call's own.

- **v22:** the Tests view and the sidebar, refined after use.
  - Asked: a test's code opens and folds with motion; Back, to return after following a link;
    the ↗ icon whole (drawn on its 16-pixel grid); a red dot on a Given or when without `setUp`
    or `setUpAll`; each test's expect calls, muted; a row's lines on hover, in the Tests view
    and on every sidebar row; the memory and CPU beside the dot; the views pinned at the top of
    the Chains and Commits tabs. Done: [Tests as sentences](#tests-as-sentences) (rule 9) and
    [Display](#display).
  - Chosen: Back is the browser's history, so its Back button and a mouse's work too, and the
    lens's "Since your review" stays pinned with "All changes" (they're one choice).
  - Found: a group's code showed only its new lines, so a Given whose old setUp was removed
    read "setup +7 −6" over additions alone (on #168, a "Given …, when …" group split in two:
    its old setUp went with the old group). A call's code now shows the lines it removed too.
    And a blank line before a new test was a change of its own, showing on its own between the
    folded tests; it now goes with the test, and blank lines between folded calls don't show.
  - Then the chain's graph, hanging from the header, drawn live on #168's `HlcManager._onUse`
    in the review artifact: one graph instead of member chips (four rows, 148 of the header's 200
    pixels there) and a graph above the code. Asked: build it as drawn, with the proposed
    answers (the open graph pushes the code down and folds with the scroll, scrolling folds a
    kept graph too, the header names the member being read, files get the button, big chains
    keep their caps and pan), and the drop and the fold moving the same way both ways. Done:
    [Display](#display). The code gets 904 of a 956-pixel pane at a time instead of 756.
  - Found: at a short window's height, the sidebar's pinned views covered most of its list; its
    top scrolls with the list below 560 pixels.
  - Then chains follow the commits by default (`-chains structure` keeps the code's), and the page
    that waits for the review, asked for motion, a better progress and room for paths: it lists
    the steps to come and the ones a cache spares, counts the analyzer's files with about how long
    is left, and is 1,040 pixels wide instead of 640. Done: [Display](#display).
  - Found: the analysis holds Node's thread (3.3 s on #168), so the page's next question waited
    and the step before it seemed to run on. The page now waits on untangle for each change, and a
    step that holds the thread starts once untangle has told the page.
  - Then untangle stops once its page closes, as asked, since the usual run is to launch it,
    review, close the page and move on: `-autoclose`, on unless set to false. Chosen: the page
    says it closed with a beacon, rather than untangle watching a connection drop, so a tab the
    browser discards doesn't stop it. Done: [Where it runs](#where-it-runs).
  - Then the Tests view folds what's reviewed, as asked: a reviewed test into a line of reviewed
    tests, a group once everything under it is (until then it mutes and its mark shows a dash), and
    a file reviewed whole, which gets a mark of its own. Done: [Tests as
    sentences](#tests-as-sentences), rule 10.
  - Then the peek, asked to open and close without stutter while the language server is slow.
    Found: a live definition opened in up to three steps (a one-line "looking it up", the answer
    with an empty or short code view, then the file), each one drawing the whole page again; and
    closing, the code jumped back to the file's first line as it folded. Done: [Display](#display),
    under Peek.
  - Then a move's link, asked to show the other copy in place before going there. Done:
    [Display](#display), under Moved code.
  - Found: a click outside a peek that also opened something, such as another test in the Tests
    view, drew the page a second time right after, which cut the peek's fold short: it vanished.
    The second drawing now ignores the peek on its way out.
  - Found: closing the review's tab in Orca's browser never stopped untangle. Orca closes a tab by
    removing its webview, so the page gets no `pagehide` and sends no beacon; only its
    connections drop. Switching tabs or worktrees keeps the page alive. Each page now holds a
    socket, and its drop closes the page unless the browser froze it first. A first try held an
    EventSource instead, but each one takes one of the six connections a browser opens to a host,
    so six tabs of a review stalled its calls; a WebSocket takes none. Done: [Where it
    runs](#where-it-runs).

## References

- [sem](https://github.com/Ataraxy-Labs/sem): entity-level diff, `impact`, `certify`.
- [inspect](https://github.com/Ataraxy-Labs/inspect): change classification and untangling.
- [dart_source_graph](https://pub.dev/packages/dart_source_graph): Dart dependency graph
  with resolved calls and references.
- [CG-Diff, arXiv 2609.32057](https://arxiv.org/abs/2609.32057): organizing PRs around
  call graphs.
- [mergiraf](https://mergiraf.org): syntax-aware git merge driver.
- [Shiki](https://shiki.style): syntax highlighting with VS Code's TextMate grammars, in
  the browser.
- [Sapling Interactive Smartlog](https://sapling-scm.com/docs/addons/isl): a local web UI
  (`sl web`) that its VS Code extension embeds.
- [git-tree-compare](https://marketplace.visualstudio.com/items?itemName=letmaik.git-tree-compare):
  compares the working tree against any branch, tag or commit; has a full diff mode.
