# Agents

- Install deps with `bun install`, then run `bun dev --hot` for hot reloads while editing. Use `bun start` when you want the production-like server.
- Primary files: `src/server.ts` (Bun server, HTML rendering, inline client script) and `src/db.ts` (SQLite helpers). Static assets live in `public/`. The SQLite file `do-the-other-stuff.sqlite` is created automatically; reset with `bun run reset-db` if needed.
- When mutating client-side state in the inline script, call `refreshUI()` so the login controls, hero input, and other UI panels redraw correctly.
- Keep the existing routes and forms intact (`/todos`, `/todos/:id/update`, `/todos/:id/state`, `/todos/:id/delete`, `/auth/login`, `/auth/logout`) to avoid breaking submissions.
- Always check for syntax errors before submitting changes by running the app locally and watching the console output.
- Always check for type errors before finishing the job.
- Ensure you always review links to images when presented in a prompt.
- Run lint before shipping: `bun run lint` (use `bun run lint:fix` for autofixes) and keep commits clean.
- Run a quick smoke check before shipping: start the app with `bun dev`, click through login/logout and add/update/delete todos, and watch the terminal for runtime errors.
- Commit every change with a clear message so rollbacks stay easy, and avoid touching unrelated local edits.
