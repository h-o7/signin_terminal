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

### Error: `spawn git ENOENT`
If you see this error when running `npm run deploy`, it means **Git is not installed** on your computer or is not in your system's PATH.

**To fix this:**
1.  **Download and install Git:** [https://git-scm.com/downloads](https://git-scm.com/downloads)
2.  **Restart your terminal/command prompt** after installation.
3.  Try running `npm run deploy` again.

### Alternative: Manual Deployment (No Git required)
If you cannot install Git, you can deploy manually:
1.  Run `npm run build`.
2.  Open your GitHub repository in your browser.
3.  Go to **Settings** > **Pages**.
4.  Under **Build and deployment** > **Source**, select **GitHub Actions**.
5.  Wait for the build to finish, or manually upload the contents of the `dist/` folder to a branch named `gh-pages`.
