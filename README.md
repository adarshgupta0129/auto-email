# Auto Email Sender

A Node.js web application to send emails with attachments, featuring QR code scanning for email addresses.

## Features

- 📧 Send emails with custom subject and message
- 📎 Attach multiple files (up to 10MB each)
- 📷 Scan QR codes/barcodes to auto-fill email addresses
- 📝 Save and reuse subject/message templates
- 💾 Save uploaded files for future use

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Create a `.env` file:

```
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-password
PORT=8000
```

**Important:** For Gmail, use an [App Password](https://myaccount.google.com/apppasswords), not your regular password.

### 3. Run Locally

```bash
npm start
```

Open: http://localhost:8000

## Deploy to Render

1. Push code to GitHub
2. Go to [render.com](https://render.com)
3. Create **New Web Service**
4. Connect your GitHub repo
5. Configure:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
6. Add Environment Variables:
   - `EMAIL_USER` = your Gmail address
   - `EMAIL_PASS` = your App Password
7. Deploy!

## Project Structure

```
auto-email/
├── server.js           # Express server
├── package.json
├── .env                # Environment variables (not in git)
├── .env.example        # Environment template
└── public/
    ├── index.html      # Frontend
    ├── style.css       # Styles
    ├── files/          # Saved attachments
    └── templates/      # Subject & message templates
        ├── subjects.txt
        └── messages.txt
```

## License

MIT
