// Frontend settings.
//
// apiUrl empty  -> guest-only app: boards stay in this browser's localStorage, no sign-in button (development).
// apiUrl set    -> the app requires an account. Signed out you get a temporary draft (kept in this tab only):
//                  you can build boards and cards, but Save asks you to sign in and autosave is off.
//
//   local development: 'http://localhost:3000'
const KANVU_CONFIG = {
    apiUrl: 'http://localhost:3000'
};
