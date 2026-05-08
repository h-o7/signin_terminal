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

## Standalone Configuration (API_CONFIG)

To use this application outside of the AI Studio environment, you must configure your own Google Cloud credentials:

1.  **Access Settings**: Click the gear icon (SYSTEM_SETTINGS) in the bottom-right.
2.  **Navigate to API_CONFIG**: Select the `API_CONFIG` tab at the top of the settings menu.
3.  **Enter Credentials**:
    - **Google Client ID**: Obtained from [Google Cloud Console](https://console.cloud.google.com/).
    - **Google Client Secret**: Obtained from Google Cloud Console.
    - **Standalone App URL**: The URL where your app is running (e.g., `http://localhost:3000`).
4.  **Save Config**: Click `SAVE_API_CONFIG` and confirm when prompted.

## Local Development

1.  **Install dependencies**: `npm install`
2.  **Start the development server**: `npm run dev`

## System Requirements
- Node.js (v18+)
- Firebase Project (configured in `src/firebase.ts`)
