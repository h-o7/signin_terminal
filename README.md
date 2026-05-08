# Sign-in Terminal & User Management System

A retro-styled terminal system for user check-ins with real-time feedback, CSV user imports, and Google Drive backup integration.

## Key Features
- **Retro Terminal Interface**: High-contrast green-on-black UI with scanning sounds and animations.
- **User Management**: Bulk import users via CSV (supports `fob_id`, `username`, `displayname`).
- **Google Drive Integration**: One-click export of system logs to Google Drive as CSV files.
- **Standalone Mode**: Configurable via UI to work without platform-specific environment variables.
- **Accessibility**: Toggle between Normal and Large font sizes in settings.

## Data Management

### Database Storage
The application uses **Firebase Firestore** as its primary database.
- **Users**: Stored in the `users` collection.
- **Logs**: Stored in the `logs` collection (linked by user/terminal ID).
- **Settings**: Persistent configuration (Client IDs, App URL) is stored locally in `settings.json` at the root of the project to allow the app to boot with the correct OAuth context even when server starts.

### Importing Users (CSV)
To import users in bulk:
1.  Navigate to **SYSTEM_SETTINGS** (gear icon).
2.  Go to the **GENERAL** tab.
3.  Click **IMPORT_USERS_VIA_CSV**.
4.  Your CSV should have at least one of these columns (headers are case-insensitive):
    - `fob_id`: Numerical ID for scanning.
    - `user_id`: Numerical ID for manual entry.
    - `username`: Unique identifier.
    - `display_name`: (Optional) Custom name shown in terminal.

## Packaging as an Executable (.exe)

To convert this web application into a standalone Windows executable:

### Option 1: Using `pkg` (Full-Stack bundle)
This approach bundles the Node.js runtime and the server code.
1.  **Build the frontend**: `npm run build`
2.  **Install pkg**: `npm install -g pkg`
3.  **Package**: `pkg . --targets node18-win-x64 --output sign-in-terminal.exe`
4.  **Note**: Ensure `dist/` folder and `settings.json` are in the same directory as the `.exe` when distributing.

### Option 2: Using Electron (Full Desktop App)
The project is already configured with Electron Forge and Vite integration.
1.  **Package**: `npm run package` (creates a portable app in `out/`).
2.  **Make**: `npm run make` (produces distribution-ready installers/zips in `out/make/`).

## Project Configuration Files

-   **forge.config.js**: The main configuration for **Electron Forge**. It defines how the desktop application is packaged, what installers (makers) are generated, and manages the integration between Electron and Vite via plugins.
-   **vite.main.config.ts**: Configures how the Electron **Main Process** (the background Node.js script) is bundled.
-   **vite.renderer.config.ts**: Configures how the Electron **Renderer Process** (the React UI) is bundled.
-   **src/electron-main.ts**: The entry point for the desktop application window management.

## Google Drive Setup Guide

To enable Google Drive export features, you must configure your own Google Cloud OAuth 2.0 credentials. This allows the application to securely save CSV logs to your Drive.

### 1. Create a Google Cloud Project
1.  Go to the [Google Cloud Console](https://console.cloud.google.com/).
2.  Create a **New Project**.
3.  Go to **APIs & Services > Library** and enable the **Google Drive API**.

### 2. Configure OAuth Consent Screen
1.  Go to **APIs & Services > OAuth consent screen**.
2.  Choose **External** user type and fill in the required app information.
3.  Add the scope: `https://www.googleapis.com/auth/drive.file`.
4.  Add your email under **Test users** while the app is in "Testing" mode.

### 3. Create Credentials
1.  Go to **APIs & Services > Credentials**.
2.  Click **Create Credentials > OAuth client ID**.
3.  Select **Web application** as the Application type.
4.  **Authorized JavaScript origins**:
    -   Add `http://localhost:3000` (for web development).
    -   Add `http://localhost:4000` (for packaged Electron apps).
    -   Add your deployed URL (e.g., `https://your-app.web.app`).
5.  **Authorized redirect URIs**:
    -   Add `http://localhost:3000/auth/callback`
    -   Add `http://localhost:4000/auth/callback`
    -   Add `https://your-app.web.app/auth/callback`
6.  Click **Create** and copy your **Client ID** and **Client Secret**.

### 4. Configure the Application
1.  Open the App Settings (gear icon in the bottom-right).
2.  Go to the **API_CONFIG** tab.
3.  Paste your **Google Client ID** and **Google Client Secret**.
4.  **Standalone App URL**:
    -   This is the base URL of your application.
    -   **Why is this needed?** It's used by the server to generate the correct return path after Google login.
    -   For **Local Web**: Use `http://localhost:3000`
    -   For **Packaged App**: Use `http://localhost:4000` (Internal server port)
    -   For **Cloud Deployment**: Use your full public URL (e.g., `https://ais-pre-...run.app`)
5.  Click `SAVE_API_SETTINGS`.

## Local Development

1.  **Install dependencies**: `npm install`
2.  **Start the development server**: `npm run dev`

## System Requirements
- Node.js (v18+)
- Firebase Project (configured in `src/firebase.ts`)
