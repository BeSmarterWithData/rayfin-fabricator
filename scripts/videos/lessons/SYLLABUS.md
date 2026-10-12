# Learn Rayfin with Ray: the lesson plan

**Learn Rayfin with Ray** is a YouTube series where Ray, Fabricator's stingray, teaches
[Rayfin](https://rayfin.ai) one short lesson at a time. The goal is Rayfin itself: its ideas,
its code and its commands. Fabricator is the harness the lessons build along with. Whenever a
lesson shows a harness, it is Fabricator and nothing else.

This file is the series' source of truth: what each lesson teaches, in what order, and how far
along it is. The `learn-rayfin-with-ray` skill (`.github/skills/learn-rayfin-with-ray/`)
reads it before making a lesson and updates the status table when a lesson ships.

- **Audience:** makers, analysts and developers who are new to Rayfin. Some TypeScript helps
  but isn't required; Ray explains the code he shows.
- **Length:** 3–5 minutes. One idea per lesson, with a demo and a quiz.
- **Rayfin version:** every lesson is checked against one Rayfin release, named in its
  `script.ts` and in its YouTube description. Season 1 is checked against **1.36.2**.
- **Playlist:** [Learn Rayfin with Ray](https://www.youtube.com/playlist?list=PLXW2FECmSE6Q) on
  [Fabricator's channel](https://www.youtube.com/@RayfinFabricator): the Fabricator intro ("meet
  your guide"), then the lessons in the order below.

## Status

| # | Lesson | Folder | Status |
| --- | --- | --- | --- |
| 1 | What is Rayfin? | `lessons/01-what-is-rayfin` | Published: [youtu.be/n-VtBCmtn78](https://youtu.be/n-VtBCmtn78) |
| 2 | Your first Rayfin app | | Planned |
| 3 | Inside a Rayfin project | | Planned |
| 4 | Entities and field types | | Planned |
| 5 | Relationships | | Planned |
| 6 | Permissions and row-level security | | Planned |
| 7 | Querying your data | | Planned |
| 8 | Creating, updating, deleting and validation | | Planned |
| 9 | Aggregations | | Planned |
| 10 | Sign-in with Microsoft Entra ID | | Planned |
| 11 | Changing your schema and deploying | | Planned |
| 12 | Capstone: build and ship an app | | Planned |

Statuses: Planned → Scripted → Approved → Voiced → Rendered → Published (with the YouTube link).

## The format of every lesson

Every lesson has the same shape, so viewers know where they are. Each beat is a scene in the
studio's lesson kit (`src/lesson-kit/`):

1. **Cold open** (about 12 s). A question and a visual payoff that make the lesson worth
   watching. No title card first.
2. **Bumper** (about 3.5 s). The "Learn Rayfin with Ray" jingle, with the lesson's number and
   title.
3. **Today you'll learn.** Three short objectives.
4. **Concept chapters.** Code cards, diagrams and big titles. Each chapter is a YouTube chapter.
5. **Deep Dive.** The water darkens, a depth gauge ticks down, and Ray shows what Rayfin
   generates or does under the surface. Every lesson has one.
6. **See it in Fabricator.** The same idea in Fabricator, from the docs screenshots, animated.
7. **Pop Quiz.** One question with three answers. Ray says "pause and guess", the bubbles count
   down, then he reveals the answer with confetti.
8. **Recap.** Three takeaways.
9. **Ray's challenge.** A prompt to paste into Fabricator's chat, and a question for the
   comments.
10. **Next up.** The next lesson, with room for YouTube's end-screen elements (15–20 s). A
    Ray fact comes last.

### Ground rules

- **Teach Rayfin.** Fabricator appears only to build along. Show what Fabricator does for
  you ("Fabricator runs `rayfin up` for you"), and show Rayfin CLI commands as "under the hood"
  cards. Never show another agent harness, IDE or chat tool.
- **Every Rayfin claim has a source.** Each line in a lesson's `script.ts` lists the rayfin.ai
  pages it rests on. Where those pages and the installed packages' own docs differ, the
  installed docs win. Those sources become the "Learn more" links in the description.
- **Code on screen compiles.** `npm run lesson:snippets -- <n>` type-checks every snippet a
  lesson shows against the real `@microsoft/rayfin-*` packages.
- **Ray stays Ray.** Short lines, his moods, at most two ocean puns per lesson, and no hype
  words ("simply", "easy", "powerful", "seamless").
- **Not official.** Each lesson's end card says the series is a community project, not an
  official Microsoft channel.

## Season 1: Rayfin 101

### Module 1: Get your fins wet

#### 1. What is Rayfin?

**YouTube title:** What is Rayfin? One TypeScript class, a whole backend | Learn Rayfin with Ray #1

- **Hook:** "What if your whole backend… was one TypeScript class?"
- **You'll learn:** what Rayfin is; how one class becomes a backend; how it ships to
  Microsoft Fabric.
- **Concepts:** Rayfin is a backend platform for TypeScript developers. An entity is a
  decorated TypeScript class: `@entity()`, field decorators such as `@text({ max })`, and a
  permission decorator with a row-level policy. One command, `rayfin up`, deploys the app as a
  Fabric app inside your organization's tenant.
- **Deep Dive:** from one class, Rayfin generates a database table, REST and GraphQL APIs, a
  type-safe client, row-level security and form validation, with no SQL, schema file or API
  contract to keep in sync by hand.
- **In Fabricator:** you describe the app, the agent writes `Expense.ts`, and Blueprint draws
  it as an entity with its access rules.
- **Pop Quiz:** Which part of an entity decides who can see each row? **The permission
  decorator and its policy.**
- **Challenge:** describe a tiny app in Fabricator, then find its entity in Blueprint.
- **Sources:** [/docs](https://rayfin.ai/docs), [/docs/data](https://rayfin.ai/docs/data),
  [/docs/data/modeling](https://rayfin.ai/docs/data/modeling),
  [/docs/data/permissions](https://rayfin.ai/docs/data/permissions)

#### 2. Your first Rayfin app

- **Hook:** from an empty folder to an app running in Fabric.
- **You'll learn:** how to scaffold a project; the dev loop; how to deploy.
- **Concepts:** `npm create @microsoft/rayfin@latest` with the default `blankapp` template (the
  Universal App); `rayfin login` (Microsoft Entra ID in the browser); `npm run dev` runs
  `rayfin dev`; `rayfin up` and `rayfin up status`. Prerequisites: Node.js 20+, the GitHub CLI
  and a Fabric account, and Fabric apps turned on in the tenant.
- **Deep Dive:** `rayfin dev` provisions or reuses the backend in Fabric and runs only the
  frontend (and any Functions) on your machine. There is no backend to run yourself.
  `rayfin dev` doesn't publish; `rayfin up` does.
- **In Fabricator:** New project → the first deploy → the preview.
- **Pop Quiz:** Which command publishes your frontend to Fabric: `rayfin dev`, `rayfin up` or
  `rayfin login`? **`rayfin up`.**
- **Sources:** [/docs/start/quickstart](https://rayfin.ai/docs/start/quickstart),
  [/docs/start/develop-locally](https://rayfin.ai/docs/start/develop-locally),
  [/docs/start/deploy-to-fabric](https://rayfin.ai/docs/start/deploy-to-fabric)

#### 3. Inside a Rayfin project

- **Hook:** "Let's take a tour of the reef."
- **You'll learn:** the Universal App's packages; `rayfin.yml`; which generated files to keep
  out of git.
- **Concepts:** `packages/frontend`, `packages/data`, `packages/shared` (and
  `packages/functions` when added). The services in `rayfin/rayfin.yml`: auth, data,
  staticHosting and functions. The Universal App starts with the data service off.
  `assetAccess` is `protected` or `public`. Rayfin projects ship skills for coding agents in
  `.agents/skills`.
- **Deep Dive:** `rayfin.yml` is the declaration that `rayfin dev` and `rayfin up` sync to Fabric.
- **In Fabricator:** the Code view's file tree; Blueprint's Architecture view.
- **Pop Quiz:** Which file records your deployments and shouldn't be committed?
  **`rayfin/.deployments.json`.**
- **Sources:** [/docs/start/project-structure](https://rayfin.ai/docs/start/project-structure),
  [/docs/reference/config/rayfin-yml](https://rayfin.ai/docs/reference/config/rayfin-yml)

### Module 2: Data, the heart of Rayfin

#### 4. Entities and field types

- **Hook:** "Every field gets a decorator, and every decorator means something."
- **You'll learn:** how to define an entity; the field types; how to register it.
- **Concepts:** `@entity()`; the `id` UUID primary key, which Rayfin adds if you leave it out;
  `@text`, `@int`, `@decimal`, `@boolean`, `@date`, `@email` and `@set`; options such as
  `optional`, `default`, `unique`, `min` and `max`. In the Universal App you register the
  entity in `packages/data/src/index.ts` and add its type in `packages/shared`. Some names,
  such as `Date`, are reserved.
- **Deep Dive:** why every `@text` needs a `max`. Without one, MSSQL gets `NVARCHAR(MAX)`,
  which can break the generated GraphQL schema after a deploy that looked fine.
- **In Fabricator:** Blueprint's Data model view shows each field's type.
- **Pop Quiz:** What's wrong with `@text() title!: string`? **It has no `max`.**
- **Sources:** [/docs/data/modeling](https://rayfin.ai/docs/data/modeling),
  [/docs/data/field-types](https://rayfin.ai/docs/data/field-types)

#### 5. Relationships

- **Hook:** "A customer has many orders. How does Rayfin know?"
- **You'll learn:** `@one` and `@many`; foreign keys; many-to-many.
- **Concepts:** `@one(() => Project)` and `@many(() => Task)`, with lazy callbacks and runtime
  imports. Rayfin generates the foreign-key columns; a key you declare follows the
  `{property}_id` naming. Writes can set a relationship with `{ project: { id } }`.
- **Deep Dive:** many-to-many isn't supported, so you use a join entity with two `@one()`.
- **In Fabricator:** the lines between entities in the Data model view.
- **Pop Quiz:** How do you model students and classes? **With a join entity, such as
  Enrollment, that has two `@one()`.**
- **Sources:** [/docs/data/relationships](https://rayfin.ai/docs/data/relationships)

#### 6. Permissions and row-level security

- **Hook:** "Your data, your rows. Nobody else's."
- **You'll learn:** the permission decorators; row-level policies; why the UI isn't security.
- **Concepts:** `@role()` and its `@anonymous()` and `@authenticated()` shorthands. Actions
  (`'*'`, create, read, update, delete). Policies on claims (`sub`, `email`, `role`), such as
  `claims.sub.eq(item.owner_id)`. Field visibility with `include` and `exclude`. Anonymous data
  on Fabric needs a tenant admin switch.
- **Deep Dive:** an entity with no permission decorator gives any signed-in user full CRUD.
  Policies run on the server, so a filter in the UI isn't access control.
- **In Fabricator:** Blueprint's access dots and **Harden**.
- **Pop Quiz:** A filter in the UI hides other people's rows. Is their data private? **No.
  Only a server-side policy keeps it private.**
- **Sources:** [/docs/data/permissions](https://rayfin.ai/docs/data/permissions)

### Module 3: Use your data

#### 7. Querying your data

- **Hook:** "Ask your data a question, in TypeScript."
- **You'll learn:** the query chain; filtering and sorting; pagination.
- **Concepts:** `client.data.<Entity>` with `select([...])`, `where({ field: { eq } })`,
  `orderBy({ createdAt: 'desc' })` and `execute()`; `findById` and `findFirst`.
- **Deep Dive:** `execute()` returns one page (100 records by default) and doesn't say whether
  there are more. Use `first(n)`, `executePaginated()` and `after(cursor)`.
- **In Fabricator:** the preview listing data.
- **Pop Quiz:** Your list stops at 100 items. Why? **`execute()` returns a single page.**
- **Sources:** [/docs/data/querying](https://rayfin.ai/docs/data/querying)

#### 8. Creating, updating, deleting and validation

- **Hook:** "Writes, with the types checked for you."
- **You'll learn:** create, update and delete; setting relationships; validating a form from
  the entity.
- **Concepts:** `create(data)`, where `id` is optional; `update(filter, data)`;
  `delete(filter)`; relationship fields as `{ id }`; a validator generated from the entity.
- **Deep Dive:** the same entity drives the database constraints and the form's validation.
- **Sources:** [/docs/data/mutations](https://rayfin.ai/docs/data/mutations),
  [/docs/data/validation](https://rayfin.ai/docs/data/validation)

#### 9. Aggregations

- **Hook:** "Totals for a dashboard, without downloading every row."
- **You'll learn:** `groupBy()`, `aggregate()` and grand totals.
- **Concepts:** `groupBy([...])`, then `aggregate({ alias: { sum: 'amount' } })`, then
  `execute()`; filtering with `where()`; skipping `groupBy()` for one total row.
- **Deep Dive:** the server computes the numbers, so only the totals travel.
- **In Fabricator:** the Contoso Expenses chart by category.
- **Sources:** [/docs/data/aggregations](https://rayfin.ai/docs/data/aggregations)

### Module 4: Ship it

#### 10. Sign-in with Microsoft Entra ID

- **Hook:** "Who's there? Microsoft Entra ID knows."
- **You'll learn:** Fabric SSO; sessions; sign-in in React.
- **Concepts:** Fabric SSO uses a popup flow in a browser (`ensureSignedInWithFabric()` from
  a user gesture) and an embedded flow inside the Fabric portal. Sessions are opaque; watch
  them with `onSessionChange`. The React integration and `assetAccess` complete the picture.
  Email and password are for local development only.
- **Deep Dive:** public pages don't make data public. Entity permissions still apply.
- **Sources:** [/docs/auth](https://rayfin.ai/docs/auth),
  [/docs/auth/fabric-sso](https://rayfin.ai/docs/auth/fabric-sso),
  [/docs/auth/react](https://rayfin.ai/docs/auth/react),
  [/docs/hosting](https://rayfin.ai/docs/hosting)

#### 11. Changing your schema and deploying

- **Hook:** "You added a column. Now what?"
- **You'll learn:** how schema changes reach the database; what `rayfin up` does; Fabric
  apps, capacity and workspaces.
- **Concepts:** `rayfin up` deploys and applies pending schema changes in one step.
  `rayfin up db apply` is the schema-only path, and `--force` allows destructive changes after
  review. Deployment records live in `rayfin/.deployments.json`. The Fabric app (preview) item
  and capacity.
- **Deep Dive:** what happens in Fabric when you run `rayfin up`.
- **In Fabricator:** Redeploy, the redeploy after each successful chat turn, and the
  deployments panel.
- **Pop Quiz:** You added a column. Which command ships it? **`rayfin up`.**
- **Sources:** [/docs/data/migrations](https://rayfin.ai/docs/data/migrations),
  [/docs/deploy/rayfin-up](https://rayfin.ai/docs/deploy/rayfin-up),
  [/docs/deploy/fabric-apps](https://rayfin.ai/docs/deploy/fabric-apps)

#### 12. Capstone: build and ship an app

- **Hook:** "Everything you've learned, in one app."
- **You'll learn:** how the pieces fit together, from start to finish.
- **Concepts:** Contoso Expenses from start to finish: an entity with an owner policy, a
  dashboard with an aggregation, sign-in, a deploy, an Advisor check and sharing.
- **Sources:** [/docs/recipes/todo-app](https://rayfin.ai/docs/recipes/todo-app) and the
  [Fabricator docs](https://spatney.github.io/rayfin-fabricator/docs)

## Season 2: Rayfin 201 (planned)

- Functions: server-side TypeScript, called from the app
- Secrets: `rayfin secret set` and `ctx.Secrets`
- Connections and the app identity
- Connectors: Fabric SQL sources, semantic models with DAX, and KQL databases
- Storage (experimental)
- Hosting: redirect URIs and deep links
- Environments and deployment pipelines
- Testing a Rayfin app
- Embedding an app in your own portal

Check each topic's availability notes on rayfin.ai before scripting it. For example, Functions
aren't in every Fabric region, and Storage is experimental.
