const express = require('express');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cors = require('cors');
const session = require('express-session');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8000;

// Google OAuth2 configuration
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.LOCAL_GOOGLE_REDIRECT_URI
);

// Scopes for Gmail access
const SCOPES = [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile'
];

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Multer configuration for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'public', 'uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        cb(null, true); // Allow all file types
    }
});

// Auth Routes
app.get('/auth/google', (req, res) => {
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent'
    });
    res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
    const { code } = req.query;
    
    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        
        // Get user info
        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const userInfo = await oauth2.userinfo.get();
        
        // Store in session
        req.session.tokens = tokens;
        req.session.user = {
            email: userInfo.data.email,
            name: userInfo.data.name,
            picture: userInfo.data.picture
        };
        
        res.redirect('/?login=success');
    } catch (error) {
        console.error('Auth error:', error);
        res.redirect('/?login=error');
    }
});

app.get('/auth/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

app.get('/auth/user', (req, res) => {
    if (req.session.user) {
        res.json({ 
            loggedIn: true, 
            user: req.session.user 
        });
    } else {
        res.json({ loggedIn: false });
    }
});

// Middleware to check authentication
const requireAuth = (req, res, next) => {
    if (!req.session.tokens) {
        return res.status(401).json({ 
            success: false, 
            message: 'Please login with Google first' 
        });
    }
    next();
};

// Route to send email using Gmail API
app.post('/send-email', upload.array('attachments', 10), requireAuth, async (req, res) => {
    try {
        const { to, subject, message, selectedFiles } = req.body;
        
        if (!to || !subject || !message) {
            return res.status(400).json({ 
                success: false, 
                message: 'To, Subject and Message are required' 
            });
        }

        // Set credentials from session
        oauth2Client.setCredentials(req.session.tokens);
        
        // Refresh token if needed
        if (req.session.tokens.expiry_date && req.session.tokens.expiry_date < Date.now()) {
            const { credentials } = await oauth2Client.refreshAccessToken();
            req.session.tokens = credentials;
            oauth2Client.setCredentials(credentials);
        }

        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        
        // Build email
        const user = req.session.user;
        let emailContent = [];
        const boundary = 'boundary_' + Date.now();
        
        // Headers
        emailContent.push(`From: ${user.name} <${user.email}>`);
        emailContent.push(`To: ${to}`);
        emailContent.push(`Subject: ${subject}`);
        emailContent.push('MIME-Version: 1.0');
        
        // Collect attachments
        let attachments = [];
        
        // Add uploaded files
        if (req.files && req.files.length > 0) {
            req.files.forEach(file => {
                attachments.push({
                    filename: file.originalname,
                    path: file.path
                });
            });
        }
        
        // Add selected files from files folder
        const filesFolder = path.join(__dirname, 'public', 'files');
        if (selectedFiles) {
            const filesArray = Array.isArray(selectedFiles) ? selectedFiles : [selectedFiles];
            filesArray.forEach(fileName => {
                const filePath = path.join(filesFolder, fileName);
                if (fileName && fs.existsSync(filePath)) {
                    attachments.push({
                        filename: fileName,
                        path: filePath
                    });
                }
            });
        }
        
        if (attachments.length > 0) {
            // Email with attachments
            emailContent.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
            emailContent.push('');
            emailContent.push(`--${boundary}`);
            emailContent.push('Content-Type: text/html; charset=UTF-8');
            emailContent.push('');
            emailContent.push(`<p>${message.replace(/\n/g, '<br>')}</p>`);
            
            // Add attachments
            for (const attachment of attachments) {
                const fileContent = fs.readFileSync(attachment.path);
                const base64File = fileContent.toString('base64');
                const mimeType = getMimeType(attachment.filename);
                
                emailContent.push(`--${boundary}`);
                emailContent.push(`Content-Type: ${mimeType}; name="${attachment.filename}"`);
                emailContent.push('Content-Transfer-Encoding: base64');
                emailContent.push(`Content-Disposition: attachment; filename="${attachment.filename}"`);
                emailContent.push('');
                emailContent.push(base64File);
            }
            
            emailContent.push(`--${boundary}--`);
        } else {
            // Simple email without attachments
            emailContent.push('Content-Type: text/html; charset=UTF-8');
            emailContent.push('');
            emailContent.push(`<p>${message.replace(/\n/g, '<br>')}</p>`);
        }
        
        const rawEmail = Buffer.from(emailContent.join('\r\n'))
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
        
        // Send email
        await gmail.users.messages.send({
            userId: 'me',
            requestBody: {
                raw: rawEmail
            }
        });
        
        // Move uploaded files to files folder (save them)
        if (req.files && req.files.length > 0) {
            if (!fs.existsSync(filesFolder)) {
                fs.mkdirSync(filesFolder, { recursive: true });
            }
            req.files.forEach(file => {
                const destPath = path.join(filesFolder, file.originalname);
                if (!fs.existsSync(destPath)) {
                    fs.renameSync(file.path, destPath);
                } else {
                    fs.unlinkSync(file.path);
                }
            });
        }

        res.json({ 
            success: true, 
            message: 'Email sent successfully!' 
        });

    } catch (error) {
        console.error('Error sending email:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to send email: ' + error.message 
        });
    }
});

// Helper function to get MIME type
function getMimeType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
        '.pdf': 'application/pdf',
        '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xls': 'application/vnd.ms-excel',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.txt': 'text/plain',
        '.zip': 'application/zip'
    };
    return mimeTypes[ext] || 'application/octet-stream';
}

// Route to get list of files in files folder
app.get('/files', (req, res) => {
    const filesFolder = path.join(__dirname, 'public', 'files');
    
    if (!fs.existsSync(filesFolder)) {
        fs.mkdirSync(filesFolder, { recursive: true });
        return res.json({ files: [] });
    }

    const files = fs.readdirSync(filesFolder).filter(file => !file.startsWith('.'));
    res.json({ files });
});

// Route to delete file from files folder
app.post('/files/delete', express.json(), (req, res) => {
    const { fileName } = req.body;
    const filesFolder = path.join(__dirname, 'public', 'files');
    const filePath = path.join(filesFolder, fileName);
    
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            res.json({ success: true, message: 'File deleted successfully' });
        } else {
            res.status(404).json({ success: false, message: 'File not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Route to get predefined subjects
app.get('/templates/subjects', (req, res) => {
    const subjectsFile = path.join(__dirname, 'public', 'templates', 'subjects.txt');
    
    if (!fs.existsSync(subjectsFile)) {
        return res.json({ subjects: [] });
    }

    const content = fs.readFileSync(subjectsFile, 'utf-8');
    const subjects = content.split('\n').filter(line => line.trim() !== '');
    res.json({ subjects });
});

// Route to get predefined messages
app.get('/templates/messages', (req, res) => {
    const messagesFile = path.join(__dirname, 'public', 'templates', 'messages.txt');
    
    if (!fs.existsSync(messagesFile)) {
        return res.json({ messages: [] });
    }

    const content = fs.readFileSync(messagesFile, 'utf-8');
    const messages = content.split('---MESSAGE---').filter(msg => msg.trim() !== '');
    res.json({ messages: messages.map(msg => msg.trim()) });
});

// Route to add new subject
app.post('/templates/subjects/add', express.json(), (req, res) => {
    const { subject } = req.body;
    const subjectsFile = path.join(__dirname, 'public', 'templates', 'subjects.txt');
    
    try {
        const templatesDir = path.dirname(subjectsFile);
        if (!fs.existsSync(templatesDir)) {
            fs.mkdirSync(templatesDir, { recursive: true });
        }
        
        let content = '';
        if (fs.existsSync(subjectsFile)) {
            content = fs.readFileSync(subjectsFile, 'utf-8');
        }
        
        const subjects = content.split('\n').filter(line => line.trim() !== '');
        if (!subjects.includes(subject.trim())) {
            fs.appendFileSync(subjectsFile, (content ? '\n' : '') + subject.trim());
        }
        
        res.json({ success: true, message: 'Subject added successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Route to delete subject
app.post('/templates/subjects/delete', express.json(), (req, res) => {
    const { subject } = req.body;
    const subjectsFile = path.join(__dirname, 'public', 'templates', 'subjects.txt');
    
    try {
        if (fs.existsSync(subjectsFile)) {
            const content = fs.readFileSync(subjectsFile, 'utf-8');
            const subjects = content.split('\n').filter(line => line.trim() !== '' && line.trim() !== subject.trim());
            fs.writeFileSync(subjectsFile, subjects.join('\n'));
        }
        
        res.json({ success: true, message: 'Subject deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Route to add new message
app.post('/templates/messages/add', express.json(), (req, res) => {
    const { message } = req.body;
    const messagesFile = path.join(__dirname, 'public', 'templates', 'messages.txt');
    
    try {
        const templatesDir = path.dirname(messagesFile);
        if (!fs.existsSync(templatesDir)) {
            fs.mkdirSync(templatesDir, { recursive: true });
        }
        
        let content = '';
        if (fs.existsSync(messagesFile)) {
            content = fs.readFileSync(messagesFile, 'utf-8');
        }
        
        fs.appendFileSync(messagesFile, (content ? '\n' : '') + '---MESSAGE---\n' + message.trim());
        
        res.json({ success: true, message: 'Message added successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Route to delete message
app.post('/templates/messages/delete', express.json(), (req, res) => {
    const { message } = req.body;
    const messagesFile = path.join(__dirname, 'public', 'templates', 'messages.txt');
    
    try {
        if (fs.existsSync(messagesFile)) {
            const content = fs.readFileSync(messagesFile, 'utf-8');
            const messages = content.split('---MESSAGE---').filter(msg => msg.trim() !== '' && msg.trim() !== message.trim());
            fs.writeFileSync(messagesFile, messages.map(msg => '---MESSAGE---\n' + msg.trim()).join('\n'));
        }
        
        res.json({ success: true, message: 'Message deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('Login with Google to start sending emails!');
});
