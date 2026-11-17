# Presently

Holiday gift tracker for staff, family and friends. Single-page app on Firebase Hosting with Firestore sync and Google sign-in.

## One-time setup

1. In the Firebase console for your project:
   - **Authentication** > Sign-in method > enable **Google**
   - **Firestore Database** > Create database (production mode, any US region)
2. On your laptop:
   ```
   git clone https://github.com/PG-Belle/presently
   cd presently
   firebase use --add        # pick your Presently project, alias it "default"
   firebase deploy
   ```
3. Open the Hosting URL it prints, tap **Sign in with Google to sync**, and add it to your phone's home screen.

## Moving data from the Claude version

In the Claude version tap **Backup / import > Copy my data**. In the Firebase version, sign in, open **Backup / import**, paste and tap **Import**.

See `CLAUDE.md` for structure, data model and design notes.
