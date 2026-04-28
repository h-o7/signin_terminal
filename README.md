# Sign-in Terminal & User Management System

A retro-styled terminal system for user check-ins with real-time feedback, CSV user imports, and Google Drive backup integration.

## Key Features
- **Retro Terminal Interface**: High-contrast green-on-black UI with scanning sounds and animations.
- **User Management**: Bulk import users via CSV (supports `fob_id`, `username`, `displayname`).
- **Google Drive Integration**: One-click export of system logs to Google Drive as CSV files.
- **Standalone Mode**: Configurable via UI to work without platform-specific environment variables.
- **Accessibility**: Toggle between Normal and Large font sizes in settings.

## Standalone Configuration (API_CONFIG)

To use this application outside of the AI Studio environment (e.g., as a packaged executable), you must configure your own Google Cloud credentials:

1.  **Access Settings**: Click the gear icon (SYSTEM_SETTINGS) in the bottom-right.
2.  **Navigate to API_CONFIG**: Select the `API_CONFIG` tab at the top of the settings menu.
3.  **Enter Credentials**:
    - **Google Client ID**: Obtained from [Google Cloud Console](https://console.cloud.google.com/).
    - **Google Client Secret**: Obtained from Google Cloud Console.
    - **Standalone App URL**: The URL where your app is running (e.g., `http://localhost:3000`).
4.  **Save Config**: Click `SAVE_API_CONFIG` and confirm when prompted.
5.  **Restart**: These settings are saved to `settings.json` at the project root and will persist after application restarts.

**Note**: You must add the `OAuth Redirect URI` shown in the settings menu to your Google Cloud Console's "Authorized redirect URIs" list.

## Local Development

1.  **Install dependencies**:
    ```bash
    npm install
    ```
2.  **Start the development server**:
    ```bash
    npm run dev
    ```

## Setup Environment Variables
If not using the UI for configuration, you can use `.env`:
```env
GOOGLE_CLIENT_ID="your_id"
GOOGLE_CLIENT_SECRET="your_secret"
APP_URL="http://localhost:3000"
```

## System Requirements
- Node.js (v18+)
- (For Executable) A tool like `pkg` or `nexe` can be used to wrap the server and frontend into a single `.exe`.
