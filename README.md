# Sign-in Terminal

This project is a terminal-based sign-in system that logs to Google Sheets.

## Local Development

1.  Install dependencies:
    ```bash
    npm install
    ```
2.  Start the development server:
    ```bash
    npm run dev
    ```

## Deployment to GitHub Pages

1.  Ensure your `vite.config.ts` has the correct `base` path:
    ```typescript
    base: '/signin_terminal/',
    ```
2.  Run the deployment script:
    ```bash
    npm run deploy
    ```
3.  In your GitHub repository settings, go to **Pages** and set the branch to `gh-pages`.

## Troubleshooting

If you get `missing script: "deploy"`, make sure you have the latest version of `package.json` from AI Studio.
Check that the `scripts` section contains:
```json
"deploy": "gh-pages -d dist"
```
