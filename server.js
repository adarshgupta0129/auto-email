const express = require('express');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

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

// Create email transporter
const createTransporter = () => {
    return nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER || 'ada@gmail.com',
            pass: process.env.EMAIL_PASS || 'your-app-password'
        }
    });
};

// Route to send email
app.post('/send-email', upload.array('attachments', 10), async (req, res) => {
    try {
        const { from, to, subject, message, senderName, selectedFiles } = req.body;
        
        if (!from || !to || !subject || !message) {
            return res.status(400).json({ 
                success: false, 
                message: 'All fields are required' 
            });
        }

        const transporter = createTransporter();

        // Format the from field with name if provided
        const fromAddress = senderName ? `${senderName} <${from}>` : from;

        const mailOptions = {
            from: fromAddress,
            to: to,
            subject: subject,
            text: message,
            html: `<p>${message.replace(/\n/g, '<br>')}</p>`,
            attachments: []
        };

        // Add uploaded files as attachments
        if (req.files && req.files.length > 0) {
            req.files.forEach(file => {
                mailOptions.attachments.push({
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
                if (fileName && fs.existsSync(path.join(filesFolder, fileName))) {
                    mailOptions.attachments.push({
                        filename: fileName,
                        path: path.join(filesFolder, fileName)
                    });
                }
            });
        }

        // Remove empty attachments array if no files
        if (mailOptions.attachments.length === 0) {
            delete mailOptions.attachments;
        }

        await transporter.sendMail(mailOptions);

        // Move uploaded files to files folder (save them)
        if (req.files && req.files.length > 0) {
            if (!fs.existsSync(filesFolder)) {
                fs.mkdirSync(filesFolder, { recursive: true });
            }
            req.files.forEach(file => {
                const destPath = path.join(filesFolder, file.originalname);
                // Only move if not already exists
                if (!fs.existsSync(destPath)) {
                    fs.renameSync(file.path, destPath);
                } else {
                    fs.unlinkSync(file.path); // Delete from uploads if already exists
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
        let content = '';
        if (fs.existsSync(subjectsFile)) {
            content = fs.readFileSync(subjectsFile, 'utf-8');
        }
        
        // Check if subject already exists
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
    console.log('Make sure to set EMAIL_USER and EMAIL_PASS in .env file');
});
