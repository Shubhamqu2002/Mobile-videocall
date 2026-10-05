# Server and browser companion

See ../README.md and ../docs/WINDOWS_SETUP.md for the current mobile POC setup and recording behavior.

Run `npm ci`, copy `.env.example` to `.env`, then `npm run build` and `npm start`.
Open http://localhost:3001 on the server computer. Use this companion with the bundled mobile app for server recording.

`npm test` runs authorization/lifecycle tests. `npm run test:browser` needs an installed Chrome/Playwright browser; see ../docs/VERIFICATION.md for what was and was not verified.
