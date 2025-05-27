// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Paths to data files
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CHAT_HISTORY_FILE = path.join(DATA_DIR, 'chatHistory.json');
const BANNED_USERS_FILE = path.join(DATA_DIR, 'bannedUsers.json');
const LOG_FILE = path.join(DATA_DIR, 'server.log.txt');

// In-memory data
let credentials = {};
let chatHistory = [];

// Active sessions: { username: socket.id }
const activeSessions = {};
// Map of socket.id -> username for cleanup
const usersBySocket = {};

// In-memory ban list
let bannedUsers = loadData(BANNED_USERS_FILE, []);

// Utility: Load data
function loadData(filePath, defaultData = {}) {
    if (fs.existsSync(filePath)) {
        try {
            const data = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(data);
        } catch (err) {
            console.error(`❌ Failed to load ${filePath}:`, err);
        }
    }
    return defaultData;
}

// Utility: Save data
function saveData(filePath, data) {
    fs.writeFile(filePath, JSON.stringify(data, null, 2), (err) => {
        if (err) {
            console.error(`❌ Failed to save ${filePath}:`, err);
        } else {
            console.log(`✅ Data saved to ${filePath}`);
        }
    });
}

// Load initial data
credentials = loadData(USERS_FILE, {});
chatHistory = loadData(CHAT_HISTORY_FILE, []);

// Helper: Save ban list
function saveBanList() {
    saveData(BANNED_USERS_FILE, bannedUsers);
}

app.use(express.static('public'));

// Handle socket connections
io.on('connection', (socket) => {
    // Get IP address (works with reverse proxies and direct connections)
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

    console.log('🔗 A user connected:', socket.id);
    appendLog(`A user connected: ${socket.id} (IP: ${ip})`);

    // Send chat history to the new user
    socket.emit('chat history', chatHistory);

    // Prompt login
    socket.emit('prompt login', 'Please log in with your username and password.');

    // Handle login
    socket.on('login', ({ username, password }) => {
        username = username.trim();
        if (bannedUsers.includes(username)) {
            socket.emit('login error', 'You are banned from this server.');
            return;
        }
        if (!username || !password) {
            socket.emit('login error', 'Username and password cannot be empty.');
            return;
        }

        if (!credentials[username]) {
            // Auto-register the user
            credentials[username] = password;
            saveData(USERS_FILE, credentials);

            // Login success
            handleSuccessfulLogin(socket, username, true, ip);
        } else if (credentials[username] === password) {
            // Check if already logged in elsewhere
            if (activeSessions[username]) {
                socket.emit('login error', 'This account is already logged in on another device.');
                console.log(`🚫 Login attempt blocked for ${username}: already logged in.`);
                appendLog(`🚫 Login attempt blocked for ${username}: already logged in. (IP: ${ip})`);
                return;
            }

            // Login success
            handleSuccessfulLogin(socket, username, false, ip);
        } else {
            socket.emit('login error', 'Incorrect password. Please try again.');
            appendLog(`❌ Incorrect password attempt for ${username}. (IP: ${ip})`);
        }

        // After successful login:
        const now = new Date();
        const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const date = now.toLocaleDateString();
        // Remove or comment out this block to stop sending "user joined" messages
        // if (username !== 'hiddenadmin') {
        //     io.emit('user joined', {
        //         user: username,
        //         time: time,
        //         date: date
        //     });
        // }
    });

    // Handle chat messages
    socket.on('chat message', (msg) => {
        const username = usersBySocket[socket.id] || 'Anonymous';
        const now = new Date();
        const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const messageObj = {
            user: username,
            text: msg,
            time: time
        };
        chatHistory.push(messageObj);
        saveData(CHAT_HISTORY_FILE, chatHistory);
        io.emit('chat message', messageObj);
    });

    // Handle disconnect
    socket.on('disconnect', () => {
        const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
        const username = usersBySocket[socket.id];
        if (username) {
            const msg = `🔌 ${username} disconnected.`;
            console.log(msg);
            appendLog(`${msg} (IP: ${ip})`);
            // Only broadcast leave message if not hiddenadmin
            if (username !== 'hiddenadmin') {
                io.emit('chat message', `${username} has left the chat.`);
            }
            delete activeSessions[username];
            delete usersBySocket[socket.id];
            updateUserList();
        } else {
            const msg = '🔌 Unknown user disconnected.';
            console.log(msg);
            appendLog(`${msg} (IP: ${ip})`);
        }
    });

    // Kick user (admin only)
    socket.on('kick user', (targetUsername) => {
        const adminUsername = usersBySocket[socket.id];
        console.log('Kick attempt by:', adminUsername); // Debug log
        if (adminUsername !== 'admin' && adminUsername !== 'hiddenadmin') {
            socket.emit('action error', 'Only admin can kick users.');
            return;
        }
        const targetSocketId = activeSessions[targetUsername];
        if (targetSocketId) {
            io.to(targetSocketId).emit('kicked', 'You have been kicked by the admin.');
            io.sockets.sockets.get(targetSocketId)?.disconnect(true);
        }
    });

    // Ban user (admin only)
    socket.on('ban user', (targetUsername) => {
        const adminUsername = usersBySocket[socket.id];
        console.log('Ban attempt by:', adminUsername); // Debug log
        if (adminUsername !== 'admin' && adminUsername !== 'hiddenadmin') {
            socket.emit('action error', 'Only admin can ban users.');
            return;
        }
        if (!bannedUsers.includes(targetUsername)) {
            bannedUsers.push(targetUsername);
            saveBanList();
        }
        const targetSocketId = activeSessions[targetUsername];
        if (targetSocketId) {
            io.to(targetSocketId).emit('banned', 'You have been banned by the admin.');
            io.sockets.sockets.get(targetSocketId)?.disconnect(true);
        }
    });
});

// Helper: Handle successful login
function handleSuccessfulLogin(socket, username, isNewUser, ip) {
    usersBySocket[socket.id] = username;
    activeSessions[username] = socket.id;

    const welcomeMsg = isNewUser
        ? `Account created. Welcome, ${username}!`
        : `Welcome back, ${username}!`;

    socket.emit('login success', welcomeMsg);

    // Only broadcast join message if not hiddenadmin
    if (username !== 'hiddenadmin') {
        io.emit('chat message', `${username} has joined the chat!`);
    }
    updateUserList();
    logUsers(ip);
}

// Helper: Update user list
function updateUserList() {
    const userList = Object.keys(activeSessions)
        .filter(u => u !== 'hiddenadmin'); // Exclude invisible admin
    io.emit('user list', userList);
}

// Helper: Log connected users to the console
function logUsers(ip) {
    const userList = Object.keys(activeSessions);
    const timestamp = new Date().toLocaleTimeString();
    const logMsg = `[${timestamp}] 👥 Connected users (${userList.length}): ${userList.join(', ')}`;
    console.log(logMsg);
    appendLog(`👥 Connected users (${userList.length}): ${userList.join(', ')}${ip ? ` (IP: ${ip})` : ''}`);
}

// Helper: Append log to file
function appendLog(message) {
    const timestamp = new Date().toLocaleString();
    fs.appendFile(LOG_FILE, `[${timestamp}] ${message}\n`, (err) => {
        if (err) console.error('❌ Failed to write to log file:', err);
    });
}

// Start server
server.listen(3000, () => {
    console.log('🚀 Server running on http://localhost:3000');
});
