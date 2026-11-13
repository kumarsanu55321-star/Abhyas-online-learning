# Abhyas

Abhyas is a responsive, gamified learning platform foundation built with React, TypeScript, Vite, Tailwind CSS, React Router, Lucide, and Supabase Authentication. The dashboard and feature areas currently use clearly identified sample data; advanced AI, live room sync, video discovery, and evaluation are UI foundations for later work.

## Requirements

- Node.js 20 or newer
- npm (or pnpm)

## Run locally

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. Build the production bundle with `npm run build`, and preview it with `npm run preview`.

## Supabase setup

1. Create a Supabase project and enable Email/Password authentication.
2. If you want Google sign-in, configure Google as an OAuth provider in Supabase and set its callback URLs.
3. Copy `.env.example` to `.env.local`.
4. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to the project's public URL and anon key. Never put a service-role key in the frontend.
5. Restart the Vite development server.

With no credentials, Login displays development preview mode; the user explicitly chooses the preview route, which only opens sample data for the current browser session. Sign-up and password recovery report that Supabase is required and never claim an account was created. Supabase sign-up includes the full name in auth user metadata as a profile foundation; create a `profiles` table and secure it with row-level security when persistence is implemented.

## Routes

Public: `/login`, `/signup`, `/forgot-password`, `/preview`. `/` routes to the dashboard for an authenticated or preview session and otherwise to login.

Protected: `/dashboard`, `/ai-tutor`, `/study-together`, `/syllabus-navigator`, `/reverse-lecture`, `/leaderboard`, `/history`, `/profile`, `/settings`.

## Project map

- `src/components/common` — shared buttons, cards, fields, progress, page headers
- `src/components/layout` — responsive sidebar, top navigation, profile menu
- `src/pages` — dashboard, auth and feature pages
- `src/context` and `src/services` — auth state and Supabase client foundation
- `src/data/mockData.ts` — sample learner, activity and course data
- `src/types` — shared TypeScript shapes

Feature pages keep their own presentation and sample interactions so team members can build them independently. To replace preview data, connect page-specific services to Supabase and update the shared types.
