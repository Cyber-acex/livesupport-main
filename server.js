// server.js
import fetch from "node-fetch";
import http from "http";
import { Server } from "socket.io";
import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import session from "express-session";
import path from "path";
import fs from "fs";
import multer from "multer";
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { db, connectDatabase, config as dbConfig } from "./db/database.js";
import { getMistralReply, initDatabase, setDisableAICallback, setHandoffCallback, isTicketCreationRequest, isRequestingStaff, MENU_ITEMS, createTicket, detectTicketCategory } from "./replies.js";
const app = express();

const upload = multer({ dest: path.join(__dirname, "uploads") });

// Initialize database connection for replies module
initDatabase(db);

// AI Response Control System
// Track when agents last sent messages per conversation
const agentActivity = new Map(); // conversation_id -> { lastMessage: timestamp, aiDisabled: boolean, timer: timeoutId }
// Track timers for snoozed escalations: conversation_id -> timeoutId
const escalationTimers = new Map();
// Track presence and typing
const onlineAgents = new Map(); // socketId -> { userId, name, role, socketId, lastActive, activeConversation }
const typingIndicators = new Map(); // conversationId -> Set of agent names
// Track user sessions to support force-logout
const userSessions = new Map(); // userId -> Set of sessionIDs

// Disable AI responses for 15 minutes after agent sends a message or after an AI handoff
function disableAIForConversation(conversationId, source = 'agent') {
    // Ensure conversation_id is a number for consistent Map lookups
    const id = Number(conversationId);
    const now = Date.now();
    const fifteenMinutes = 15 * 60 * 1000;

    // Clear any existing timer
    if (agentActivity.has(id)) {
        const existing = agentActivity.get(id);
        if (existing.timer) {
            clearTimeout(existing.timer);
        }
    }

    // Set AI as disabled and start timer
    agentActivity.set(id, {
        lastMessage: now,
        aiDisabled: true,
        source,
        timer: setTimeout(() => {
            // Re-enable AI after 15 minutes
            const data = agentActivity.get(id);
            if (data) {
                data.aiDisabled = false;
                data.timer = null;
                console.log(`✅ AI responses re-enabled for conversation ${id} after 15 minutes`);
            }
        }, fifteenMinutes)
    });

    console.log(`🚫 AI responses DISABLED for conversation ${id} for 15 minutes`, {
        conversationId: id,
        timestamp: new Date().toISOString(),
        mapSize: agentActivity.size
    });
}

// Set the callback for disabling AI in replies module
setDisableAICallback((conversationId) => {
    disableAIForConversation(conversationId, 'handoff');
});

// Check if AI should respond to a conversation
function shouldAIRespond(conversationId) {
    // Ensure conversation_id is a number for consistent Map lookups
    const id = Number(conversationId);
    const data = agentActivity.get(id);
    const should = !data || !data.aiDisabled;
    console.log(`shouldAIRespond check for conversation ${id}:`, {
        originalId: conversationId,
        numericId: id,
        hasData: !!data,
        aiDisabled: data?.aiDisabled,
        shouldRespond: should,
        mapSize: agentActivity.size,
        mapKeys: Array.from(agentActivity.keys())
    });
    return should;
}

function isCustomerGreeting(text) {
    if (!text) return false;
    const normalized = text.toLowerCase().trim();
    const greetings = [
        'hey',
        'hello',
        'hi',
        'hiya',
        'yo',
        'good morning',
        'good afternoon',
        'good evening',
        'what\'s up',
        'sup'
    ];
    return greetings.some(greeting =>
        normalized === greeting ||
        normalized.startsWith(greeting + ' ') ||
        normalized.endsWith(' ' + greeting) ||
        normalized.includes(' ' + greeting + ' ') ||
        normalized === greeting + '!' ||
        normalized === greeting + '.'
    );
}

function enableAIForConversation(conversationId) {
    const id = Number(conversationId);
    const existing = agentActivity.get(id);

    if (existing) {
        if (existing.timer) {
            clearTimeout(existing.timer);
        }
        existing.aiDisabled = false;
        existing.timer = null;
        agentActivity.set(id, existing);
    } else {
        agentActivity.set(id, { lastMessage: Date.now(), aiDisabled: false, timer: null, source: 'agent' });
    }

    console.log(`✅ AI responses re-enabled immediately for conversation ${id} after customer greeting`);
}

function isStaffIdleForThreeMinutes(conversationId) {
    const id = Number(conversationId);
    const data = agentActivity.get(id);
    if (!data || !data.aiDisabled || data.source !== 'agent') {
        return false;
    }

    const threeMinutes = 3 * 60 * 1000;
    return (Date.now() - data.lastMessage) >= threeMinutes;
}

// Automated ticket creation function
async function checkAndCreateTicket(conversationId, phone, message) {
    // Auto-create a ticket when our keyword detector sees a support issue or complaint.
    // It will assign the ticket to the best matching staff role based on the message.
    const problemKeywords = [
        // Delivery issues
        'late', 'delayed', 'delay', 'slow', 'not arrived', 'waiting', 'ETA', 'estimated', 'delivery time', 'taking long', 'where is', 'not here', 'missing delivery', 'late delivery', 'delayed delivery',
        // Refund issues
        'refund', 'money back', 'return my money', 'cancel order', 'cancel my order', 'chargeback', 'refund request', 'back', 'return', 'cancel', 'charge back', 'want refund', 'need refund', 'get money back',
        // Kitchen/food issues
        'allergy', 'allergic', 'bad food', 'food quality', 'tastes bad', 'spoiled', 'cold food', 'cold order', 'cold', 'taste', 'smell', 'texture', 'wrong', 'missing', 'burnt', 'undercooked', 'overcooked', 'raw', 'soggy', 'dry', 'allergic reaction', 'food poisoning', 'sick', 'ill',
        // General complaints
        'complaint', 'complain', 'issue', 'problem', 'help', 'trouble', 'support', 'not happy', 'dissatisfied', 'unhappy', 'angry', 'frustrated', 'terrible', 'awful', 'horrible', 'worst', 'error', 'bug', 'broken', 'stuck', 'failed', 'not working', 'doesn\'t work', 'won\'t work', 'glitch', 'crash', 'freeze'
    ];
    const lowerMessage = message.toLowerCase();
    const hasProblem = problemKeywords.some(keyword => lowerMessage.includes(keyword));

    if (!hasProblem) return;

    db.query(`
        SELECT sender, message FROM messages 
        WHERE conversation_id = ? 
        ORDER BY created_at DESC LIMIT 10
    `, [conversationId], async (err, messages) => {
        if (err) {
            console.log("Error checking messages for auto-ticket:", err);
            return;
        }

        const customerMessages = messages.filter(m => m.sender !== 'sent').length;
        const agentMessages = messages.filter(m => m.sender === 'sent').length;

        // Create ticket when a problem keyword appears and the customer has no recent agent response.
        if (agentMessages === 0) {
            const assignee = detectTicketCategory(message);
            console.log(`Auto-creating ticket for conversation ${conversationId}. Assigning to: ${assignee}`);

            const ticket = await createTicket(message, phone, conversationId, assignee);
            if (ticket) {
                console.log(`Ticket #${ticket.id} auto-created for conversation ${conversationId} and assigned to ${assignee}`);
                io.emit('ticketCreated', ticket);
                io.emit('staffNotification', {
                    message: `Ticket #${ticket.id} created`,
                    from: 'Auto creation system',
                    time: new Date().toISOString()
                });
            }
        }
    });
}

// Create/ensure schema for several tables with Postgres compatibility when configured
const isPg = !!(dbConfig && dbConfig.usePostgres);

function getSlaMinutes(assignee, ticketType) {
    const value = `${assignee || ''} ${ticketType || ''}`.toLowerCase();
    if (value.includes('refund')) return 60;
    if (value.includes('kitchen') || value.includes('quality') || value.includes('food') || value.includes('cold')) return 90;
    if (value.includes('delivery') || value.includes('late') || value.includes('delay')) return 120;
    return 180;
}

function computeSlaDue(assignee, ticketType) {
    const minutes = getSlaMinutes(assignee, ticketType);
    return new Date(Date.now() + minutes * 60 * 1000);
}

if (isPg) {
    // Postgres-friendly DDL
    db.query(`
        CREATE TABLE IF NOT EXISTS conversations (
            id INT AUTO_INCREMENT PRIMARY KEY,
            phone VARCHAR(255),
            name VARCHAR(255),
            platform VARCHAR(50) DEFAULT 'whatsapp',
            last_viewed TIMESTAMP NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `, (err) => {
        if (err) console.log('Error creating conversations table (pg):', err);
    });

    db.query(`
        CREATE TABLE IF NOT EXISTS resolved (
            id INT AUTO_INCREMENT PRIMARY KEY,
            conversation_id INT,
            resolved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        );
    `, (err) => { if (err) console.log('Error creating resolved table (pg):', err); });

    db.query(`
        CREATE TABLE IF NOT EXISTS escalations (
            id INT AUTO_INCREMENT PRIMARY KEY,
            conversation_id INT UNIQUE,
            customer_name VARCHAR(255),
            escalated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        );
    `, (err) => { if (err) console.log('Error creating escalations table (pg):', err); });

    db.query("ALTER TABLE escalations ADD COLUMN IF NOT EXISTS claimed_by VARCHAR(255)", (err) => { if (err) console.log('Error adding claimed_by to escalations (pg):', err); });
    db.query("ALTER TABLE escalations ADD COLUMN IF NOT EXISTS claim_time TIMESTAMP", (err) => { if (err) console.log('Error adding claim_time to escalations (pg):', err); });

    // Create AI/staff split message tables (optional enhanced schema)
    db.query(`
        CREATE TABLE IF NOT EXISTS ai_messages (
            id INT AUTO_INCREMENT PRIMARY KEY,
            conversation_id INT,
            sender VARCHAR(255),
            message TEXT,
            user_id INT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `, (err) => { if (err) console.log('Error creating ai_messages table (pg):', err); });

    db.query(`
        CREATE TABLE IF NOT EXISTS staff_messages (
            id INT AUTO_INCREMENT PRIMARY KEY,
            conversation_id INT,
            sender VARCHAR(255),
            message TEXT,
            user_id INT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `, (err) => { if (err) console.log('Error creating staff_messages table (pg):', err); });
    // Create tables with spaces in names as requested
    db.query(`
        CREATE TABLE IF NOT EXISTS "ai replies" (
            id INT AUTO_INCREMENT PRIMARY KEY,
            conversation_id INT,
            sender VARCHAR(255),
            message TEXT,
            user_id INT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `, (err) => { if (err) console.log('Error creating "ai replies" table (pg):', err); });

    db.query(`
        CREATE TABLE IF NOT EXISTS "staff replies" (
            id INT AUTO_INCREMENT PRIMARY KEY,
            conversation_id INT,
            sender VARCHAR(255),
            message TEXT,
            user_id INT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `, (err) => { if (err) console.log('Error creating "staff replies" table (pg):', err); });
    db.query("ALTER TABLE escalations ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMP", (err) => { if (err) console.log('Error adding snoozed_until to escalations (pg):', err); });
    db.query("ALTER TABLE escalations ADD COLUMN IF NOT EXISTS alarm_active BOOLEAN DEFAULT true", (err) => { if (err) console.log('Error adding alarm_active to escalations (pg):', err); });

    db.query(`
        CREATE TABLE IF NOT EXISTS refunds (
            id INT AUTO_INCREMENT PRIMARY KEY,
            conversation_id INT,
            customer_name VARCHAR(255),
            refunded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        );
    `, (err) => { if (err) console.log('Error creating refunds table (pg):', err); });

    db.query(`
        CREATE TABLE IF NOT EXISTS ai_feedback (
            id INT AUTO_INCREMENT PRIMARY KEY,
            conversation_id INT NULL,
            message_id INT NULL,
            user_id INT NULL,
            rating SMALLINT NULL,
            feedback_text TEXT NULL,
            correction TEXT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `, (err) => { if (err) console.log('Error creating ai_feedback table (pg):', err); });
    db.query('CREATE INDEX IF NOT EXISTS idx_ai_feedback_conv ON ai_feedback(conversation_id)', (err) => {});
    db.query('CREATE INDEX IF NOT EXISTS idx_ai_feedback_user ON ai_feedback(user_id)', (err) => {});

    db.query('CREATE INDEX IF NOT EXISTS idx_refunds_conversation_id ON refunds(conversation_id)', (err) => {});

    db.query(`
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            email VARCHAR(255) UNIQUE,
            password VARCHAR(255),
            name VARCHAR(255),
            role VARCHAR(50) DEFAULT 'agent',
            disabled BOOLEAN DEFAULT false,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `, (err) => { if (err) console.log('Error creating users table (pg):', err); });

    db.query(`
        CREATE TABLE IF NOT EXISTS delivery_issues (
            id INT AUTO_INCREMENT PRIMARY KEY,
            conversation_id INT,
            customer_name VARCHAR(255),
            reported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        );
    `, (err) => { if (err) console.log('Error creating delivery_issues table (pg):', err); });

    db.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled BOOLEAN DEFAULT false", (err) => { if (err) console.log('Error adding disabled to users (pg):', err); });

    db.query('CREATE INDEX IF NOT EXISTS idx_delivery_issues_conversation_id ON delivery_issues(conversation_id)', (err) => {});

    db.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_tokens (
            id INT AUTO_INCREMENT PRIMARY KEY,
            token TEXT,
            expires_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `, (err) => { if (err) console.log('Error creating whatsapp_tokens table (pg):', err); });

    db.query(`
        CREATE TABLE IF NOT EXISTS instagram_tokens (
            id INT AUTO_INCREMENT PRIMARY KEY,
            token TEXT,
            expires_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `, (err) => { if (err) console.log('Error creating instagram_tokens table (pg):', err); });
} else {
    // MySQL-compatible DDL (keep original behavior)
    db.query(`
        CREATE TABLE IF NOT EXISTS conversations (
            id INT AUTO_INCREMENT PRIMARY KEY,
            phone VARCHAR(255),
            name VARCHAR(255),
            platform VARCHAR(50) DEFAULT 'whatsapp',
            last_viewed TIMESTAMP NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) {
            console.log("Error creating conversations table:", err);
        } else {
            db.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS platform VARCHAR(50) DEFAULT 'whatsapp'`, (alterErr) => {
                if (alterErr) console.log("Error adding platform column to conversations:", alterErr);
            });
            db.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_viewed TIMESTAMP NULL`, (alterErr) => {
                if (alterErr) console.log("Error adding last_viewed column to conversations:", alterErr);
            });
        }
    });

    db.query(`
        CREATE TABLE IF NOT EXISTS resolved (
            id INT AUTO_INCREMENT PRIMARY KEY,
            conversation_id INT,
            resolved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        )
    `, (err) => {
        if (err) console.log("Error creating resolved table:", err);
    });

    db.query(`
        CREATE TABLE IF NOT EXISTS escalations (
            id INT AUTO_INCREMENT PRIMARY KEY,
            conversation_id INT UNIQUE,
            customer_name VARCHAR(255),
            escalated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        )
    `, (err) => {
        if (err) console.log("Error creating escalations table:", err);
    });

    db.query("ALTER TABLE escalations ADD COLUMN IF NOT EXISTS claimed_by VARCHAR(255) NULL", (err) => {
        if (err && err.errno !== 1060) console.log("Error adding claimed_by to escalations:", err);
    });
    db.query("ALTER TABLE escalations ADD COLUMN IF NOT EXISTS claim_time TIMESTAMP NULL", (err) => {
        if (err && err.errno !== 1060) console.log("Error adding claim_time to escalations:", err);
    });
    db.query("ALTER TABLE escalations ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMP NULL", (err) => {
        if (err && err.errno !== 1060) console.log("Error adding snoozed_until to escalations:", err);
    });
    db.query("ALTER TABLE escalations ADD COLUMN IF NOT EXISTS alarm_active TINYINT(1) DEFAULT 1", (err) => {
        if (err && err.errno !== 1060) console.log("Error adding alarm_active to escalations:", err);
    });

    db.query(`
        CREATE TABLE IF NOT EXISTS refunds (
            id INT AUTO_INCREMENT PRIMARY KEY,
            conversation_id INT,
            customer_name VARCHAR(255),
            refunded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        )
    `, (err) => {
        if (err) console.log("Error creating refunds table:", err);
    });

    db.query(`
        CREATE TABLE IF NOT EXISTS ai_feedback (
            id INT AUTO_INCREMENT PRIMARY KEY,
            conversation_id INT NULL,
            message_id INT NULL,
            user_id INT NULL,
            rating TINYINT NULL,
            feedback_text TEXT NULL,
            correction TEXT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_ai_feedback_conv (conversation_id),
            INDEX idx_ai_feedback_user (user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `, (err) => {
        if (err) console.log('Error creating ai_feedback table:', err);
    });

    db.query("ALTER TABLE refunds ADD INDEX idx_refunds_conversation_id (conversation_id)", (err) => {
        if (err && err.errno !== 1061) {
            console.log("Error adding refunds conversation_id index:", err);
        }
        db.query("ALTER TABLE refunds DROP INDEX conversation_id", (dropErr) => {
            if (dropErr && dropErr.errno !== 1091) {
                console.log("Error dropping refunds unique index:", dropErr);
            }
        });
    });

    db.query(`
        CREATE TABLE IF NOT EXISTS delivery_issues (
            id INT AUTO_INCREMENT PRIMARY KEY,
            conversation_id INT,
            customer_name VARCHAR(255),
            reported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        )
    `, (err) => {
        if (err) console.log("Error creating delivery_issues table:", err);
    });

    db.query("ALTER TABLE users ADD COLUMN disabled TINYINT(1) DEFAULT 0", (err) => {
        if (err && err.errno !== 1060) {
            console.log("Error adding disabled to users:", err);
        }
    });

    db.query("ALTER TABLE delivery_issues ADD INDEX idx_delivery_issues_conversation_id (conversation_id)", (err) => {
        if (err && err.errno !== 1061) {
            console.log("Error adding delivery_issues conversation_id index:", err);
        }
        db.query("ALTER TABLE delivery_issues DROP INDEX conversation_id", (dropErr) => {
            if (dropErr && dropErr.errno !== 1091) {
                console.log("Error dropping delivery_issues unique index:", dropErr);
            }
        });
    });

    db.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_tokens (
            id INT AUTO_INCREMENT PRIMARY KEY,
            token TEXT,
            expires_at DATETIME,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) console.log("Error creating whatsapp_tokens table:", err);
    });

    db.query(`
        CREATE TABLE IF NOT EXISTS instagram_tokens (
            id INT AUTO_INCREMENT PRIMARY KEY,
            token TEXT,
            expires_at DATETIME,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `, (err) => {
        if (err) console.log('Error creating instagram_tokens table:', err);
    });
}

function storeInstagramToken(token, expiresInSeconds = null) {
    const expiresAt = expiresInSeconds ? new Date(Date.now() + expiresInSeconds * 1000) : null;
    db.query(
        "INSERT INTO instagram_tokens (token, expires_at) VALUES (?, ?)",
        [token, expiresAt],
        (err) => {
            if (err) console.error('Error storing Instagram token:', err);
        }
    );
}

function storeWhatsAppToken(token, expiresInSeconds = null) {
    const expiresAt = expiresInSeconds ? new Date(Date.now() + expiresInSeconds * 1000) : null;
    db.query(
        "INSERT INTO whatsapp_tokens (token, expires_at) VALUES (?, ?)",
        [token, expiresAt],
        (err) => {
            if (err) console.error("Error storing WhatsApp token:", err);
        }
    );
}

function getStoredWhatsAppToken() {
    return new Promise((resolve, reject) => {
        db.query(
            "SELECT token, expires_at FROM whatsapp_tokens ORDER BY created_at DESC LIMIT 1",
            (err, results) => {
                if (err) return reject(err);
                if (!results || results.length === 0) return resolve(null);
                resolve(results[0]);
            }
        );
    });
}

async function getWhatsAppToken() {
    if (process.env.WHATSAPP_TOKEN) {
        return process.env.WHATSAPP_TOKEN;
    }

    const row = await getStoredWhatsAppToken();
    if (!row || !row.token) {
        throw new Error("WhatsApp token is not configured. Add it in your .env or save it via /api/whatsapp-token.");
    }

    if (row.expires_at && new Date(row.expires_at) <= new Date()) {
        throw new Error("Stored WhatsApp token has expired. Update it via /api/whatsapp-token.");
    }

    return row.token;
}

async function exchangeWhatsAppToken(shortLivedToken) {
    const clientId = process.env.WHATSAPP_APP_ID;
    const clientSecret = process.env.WHATSAPP_APP_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error("Missing WHATSAPP_APP_ID or WHATSAPP_APP_SECRET for token exchange.");
    }

    const url = `https://graph.facebook.com/v18.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${clientId}&client_secret=${clientSecret}&fb_exchange_token=${encodeURIComponent(shortLivedToken)}`;
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok || !data.access_token) {
        throw new Error(`Token exchange failed: ${JSON.stringify(data)}`);
    }

    storeWhatsAppToken(data.access_token, data.expires_in);
    return data;
}

app.post('/api/whatsapp-token', (req, res) => {
    const { token, expires_in } = req.body;
    if (!token) {
        return res.status(400).json({ error: "Missing WhatsApp token." });
    }

    storeWhatsAppToken(token, expires_in || null);
    res.json({ success: true });
});

app.post('/api/whatsapp-token/exchange', async (req, res) => {
    const { token } = req.body;
    const sourceToken = token || process.env.WHATSAPP_TOKEN;
    if (!sourceToken) {
        return res.status(400).json({ error: "Missing source token for exchange." });
    }

    try {
        const exchangedData = await exchangeWhatsAppToken(sourceToken);
        res.json({ success: true, expires_in: exchangedData.expires_in || null });
    } catch (error) {
        console.error("WhatsApp token exchange error:", error);
        res.status(500).json({ error: error.message || "Token exchange failed." });
    }
});

// API to record AI feedback from staff or customers
app.post('/api/ai-feedback', express.json(), async (req, res) => {
    try {
        const { conversation_id, message_id, user_id, rating, feedback_text, correction } = req.body || {};
        if (!conversation_id && !message_id) {
            // allow feedback without conversation linkage but require some content
            if (!feedback_text && !correction) return res.status(400).json({ error: 'Missing identifiers or feedback content' });
        }

        const sql = isPg
            ? `INSERT INTO ai_feedback (conversation_id, message_id, user_id, rating, feedback_text, correction) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
            : `INSERT INTO ai_feedback (conversation_id, message_id, user_id, rating, feedback_text, correction) VALUES (?, ?, ?, ?, ?, ?)`;
        db.query(sql, [conversation_id || null, message_id || null, user_id || null, rating || null, feedback_text || null, correction || null], (err, result) => {
            if (err) {
                console.error('Failed to save ai_feedback:', err);
                return res.status(500).json({ error: 'db_error' });
            }
            res.json({ success: true, id: result.insertId });
        });
    } catch (e) {
        console.error('ai-feedback error', e);
        res.status(500).json({ error: 'internal_error' });
    }
});

// Simple endpoint to fetch recent feedback (admin use)
app.get('/api/ai-feedback', async (req, res) => {
    const limit = Math.min(1000, parseInt(req.query.limit || '200', 10));
    db.query('SELECT * FROM ai_feedback ORDER BY created_at DESC LIMIT ?', [limit], (err, results) => {
        if (err) return res.status(500).json({ error: 'db_error' });
        res.json(results || []);
    });
});

// Create user settings, messages, instagram_conversations, replies, receipts, tickets (Postgres or MySQL)
if (isPg) {
    db.query(`
        CREATE TABLE IF NOT EXISTS settings (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT UNIQUE,
            displayName VARCHAR(255),
            email VARCHAR(255),
            password VARCHAR(255),
            autoReply VARCHAR(255),
            chatEnabled VARCHAR(10),
            msgAlert BOOLEAN,
            ticketAlert BOOLEAN,
            soundAlert BOOLEAN,
            priority VARCHAR(20),
            autoAssign VARCHAR(10),
            theme VARCHAR(20),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
    `, (err) => { if (err) console.log('Error creating settings table (pg):', err); });

    db.query(`
        CREATE TABLE IF NOT EXISTS messages (
            id INT AUTO_INCREMENT PRIMARY KEY,
            conversation_id INT,
            sender VARCHAR(50),
            message TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        );
    `, (err) => { if (err) console.log('Error creating messages table (pg):', err); });

    db.query(`
        CREATE TABLE IF NOT EXISTS instagram_conversations (
            id INT AUTO_INCREMENT PRIMARY KEY,
            conversation_id INT UNIQUE,
            ig_id VARCHAR(255),
            ig_username VARCHAR(255),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );
    `, (err) => { if (err) console.log('Error creating instagram_conversations table (pg):', err); });

    db.query(`
        CREATE TABLE IF NOT EXISTS replies (
            id INT AUTO_INCREMENT PRIMARY KEY,
            conversation_id INT,
            sender VARCHAR(50),
            message TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        );
    `, (err) => { if (err) console.log('Error creating replies table (pg):', err); });

    db.query("ALTER TABLE replies ADD COLUMN IF NOT EXISTS user_id INT", (err) => { if (err) console.log('Error adding user_id to replies (pg):', err); });

    db.query(`
        CREATE TABLE IF NOT EXISTS receipts (
            id INT AUTO_INCREMENT PRIMARY KEY,
            content TEXT,
            escalated BOOLEAN DEFAULT false,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `, (err) => { if (err) console.log('Error creating receipts table (pg):', err); });

    db.query(`
        CREATE TABLE IF NOT EXISTS tickets (
            id INT AUTO_INCREMENT PRIMARY KEY,
            content TEXT,
            escalated BOOLEAN DEFAULT false,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `, (err) => { if (err) console.log('Error creating tickets table (pg):', err); });

    db.query("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ticket_type VARCHAR(255)", (err) => {});
    db.query("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS subject VARCHAR(255)", (err) => {});
    db.query("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255)", (err) => {});
    db.query("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(255)", (err) => {});
    db.query("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assignee VARCHAR(255)", (err) => {});
    db.query("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS priority VARCHAR(20)", (err) => {});
    db.query("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Open'", (err) => {});
    db.query("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tags TEXT", (err) => {});
    db.query("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS attachments TEXT", (err) => {});
    db.query("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_due TIMESTAMP", (err) => {});
} else {
    // keep MySQL originals
    db.query(`
        CREATE TABLE IF NOT EXISTS settings (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT UNIQUE,
            displayName VARCHAR(255),
            email VARCHAR(255),
            password VARCHAR(255),
            autoReply VARCHAR(255),
            chatEnabled VARCHAR(10),
            msgAlert TINYINT(1),
            ticketAlert TINYINT(1),
            soundAlert TINYINT(1),
            priority VARCHAR(20),
            autoAssign VARCHAR(10),
            theme VARCHAR(20),
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    `, (err) => { if (err) console.log('Error creating settings table:', err); });

    db.query(`
        CREATE TABLE IF NOT EXISTS messages (
            id INT AUTO_INCREMENT PRIMARY KEY,
            conversation_id INT,
            sender VARCHAR(50),
            message TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        )
    `, (err) => { if (err) console.log('Error creating messages table:', err); });

    db.query(`
        CREATE TABLE IF NOT EXISTS instagram_conversations (
            id INT AUTO_INCREMENT PRIMARY KEY,
            conversation_id INT UNIQUE,
            ig_id VARCHAR(255),
            ig_username VARCHAR(255),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `, (err) => { if (err) console.log('Error creating instagram_conversations table:', err); });

    db.query(`
        CREATE TABLE IF NOT EXISTS replies (
            id INT AUTO_INCREMENT PRIMARY KEY,
            conversation_id INT,
            sender VARCHAR(50),
            message TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        )
    `, (err) => { if (err) console.log('Error creating replies table:', err); });

    db.query("ALTER TABLE replies ADD COLUMN IF NOT EXISTS user_id INT NULL", (err) => { if (err && err.errno !== 1060) console.log('Error adding user_id to replies:', err); });

    db.query(`
        CREATE TABLE IF NOT EXISTS receipts (
            id INT AUTO_INCREMENT PRIMARY KEY,
            content TEXT,
            escalated TINYINT(1) DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => { if (err) console.log('Error creating receipts table:', err); });

    db.query(`
        CREATE TABLE IF NOT EXISTS tickets (
            id INT AUTO_INCREMENT PRIMARY KEY,
            content TEXT,
            escalated TINYINT(1) DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => { if (err) console.log('Error creating tickets table:', err); });

    db.query("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ticket_type VARCHAR(255)", (err) => { if (err && err.errno !== 1060) console.log('Error adding ticket_type to tickets:', err); });
    db.query("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS subject VARCHAR(255)", (err) => { if (err && err.errno !== 1060) console.log('Error adding subject to tickets:', err); });
    db.query("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255)", (err) => { if (err && err.errno !== 1060) console.log('Error adding customer_name to tickets:', err); });
    db.query("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(255)", (err) => { if (err && err.errno !== 1060) console.log('Error adding customer_phone to tickets:', err); });
    db.query("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assignee VARCHAR(255)", (err) => { if (err && err.errno !== 1060) console.log('Error adding assignee to tickets:', err); });
    db.query("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS priority VARCHAR(20)", (err) => { if (err && err.errno !== 1060) console.log('Error adding priority to tickets:', err); });
    db.query("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Open'", (err) => { if (err && err.errno !== 1060) console.log('Error adding status to tickets:', err); });
    db.query("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tags TEXT", (err) => { if (err && err.errno !== 1060) console.log('Error adding tags to tickets:', err); });
    db.query("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS attachments TEXT", (err) => { if (err && err.errno !== 1060) console.log('Error adding attachments to tickets:', err); });
    db.query("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_due TIMESTAMP", (err) => { if (err && err.errno !== 1060) console.log('Error adding sla_due to tickets:', err); });
}


// ---------------------------
// Middleware
// ---------------------------
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.use(session({
    secret: "livesupportsecret",
    resave: false,
    saveUninitialized: true
}));

// Middleware to protect HTML pages
app.use((req, res, next) => {
    if (req.path.endsWith('.html') && req.path !== '/login.html' && req.path !== '/knowledge.html' && req.path !== '/orders.html') {
        if (!req.session.user) {
            return res.redirect('/login.html');
        }
    }
    next();
});

// Protect admin assets/pages before static middleware: require login only
app.use((req, res, next) => {
    if (req.path === '/admin-users.html' || req.path.startsWith('/js/admin-users')) {
        if (!req.session || !req.session.user) return res.redirect('/login.html');
    }
    next();
});

// Serve favicon explicitly to avoid caching/path issues
app.get('/favicon.svg', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.sendFile(path.join(__dirname, 'public', 'favicon.svg'));
});
app.get('/favicon.ico', (req, res) => {
    res.redirect('/favicon.svg');
});
app.get('/favicon-icon.svg', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.sendFile(path.join(__dirname, 'public', 'favicon-icon.svg'));
});

app.use(express.static(path.join(__dirname, 'public')));

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

if (!fs.existsSync(path.join(__dirname, "uploads"))) {
    fs.mkdirSync(path.join(__dirname, "uploads"), { recursive: true });
}

function isAuthenticated(req, res, next) {
    if (req.session && req.session.user) {
        return next();
    }
    // If the client expects JSON (AJAX/fetch) or it's an API request, return 401 JSON
    const accept = req.headers && req.headers.accept ? String(req.headers.accept) : '';
    const isAjax = req.xhr || (req.headers['x-requested-with'] === 'XMLHttpRequest');
    if (isAjax || accept.indexOf('application/json') !== -1 || (req.path && req.path.startsWith('/api'))) {
        return res.status(401).json({ error: 'not_logged_in' });
    }
    // Otherwise redirect to login page for normal browser navigation
    return res.redirect('/login.html');
}

// Enforce read-only for users with role 'viewer' on API endpoints
app.use((req, res, next) => {
    try {
        const role = req.session && req.session.user && req.session.user.role ? String(req.session.user.role).toLowerCase() : null;
        // Only enforce for logged-in viewers
        if (role === 'viewer') {
            // Allow navigation (GET/HEAD) everywhere, but block non-GET API actions
            if (req.path.startsWith('/api') && req.method !== 'GET' && req.method !== 'HEAD') {
                return res.status(403).json({ error: 'read_only_viewer' });
            }
            // Prevent debug emit helper for viewers
            if (req.path.startsWith('/debug') && req.method !== 'GET') {
                return res.status(403).json({ error: 'read_only_viewer' });
            }
        }
    } catch (e) {
        console.error('Viewer middleware error', e);
    }
    next();
});

// ---------------------------
// Auth Routes
// ---------------------------
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/login", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/login", (req, res) => {
    const { email, password } = req.body;
    console.log("Login attempt:", email, password);
    const sql = "SELECT * FROM users WHERE email = ? AND password = ?";
    // Use pool.query which handles connection acquisition/release internally
    db.query(sql, [email, password], (err, result) => {
        console.log("DB result:", result);
        if (err) {
            console.error('Login DB error:', err);
            return res.status(500).send('Internal Server Error');
        }
        if (result && result.length > 0) {
                req.session.user = result[0];
                req.session.userId = result[0].id;
                // Track this session id for the logged-in user to allow force-logout
                try {
                    const sid = req.sessionID;
                    const uid = String(result[0].id);
                    const set = userSessions.get(uid) || new Set();
                    set.add(sid);
                    userSessions.set(uid, set);
                    try { io.emit('admin:users:changed', { action: 'login', id: uid }); } catch (e) { console.error('Emit admin users changed error', e); }
                } catch (e) {
                    console.error('Failed to track user session', e);
                }
            res.redirect("/dashboard");
        } else {
            res.redirect("/login.html?error=invalid");
        }
    });
});

// Exchange Google authorization code for tokens, fetch userinfo, create/find user and establish session
app.post('/auth/google', async (req, res) => {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'missing_code' });

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) return res.status(500).json({ error: 'google_client_not_configured' });

    try {
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: 'postmessage',
                grant_type: 'authorization_code'
            }).toString()
        });

        const tokenData = await tokenRes.json();
        if (!tokenRes.ok || !tokenData || !tokenData.access_token) {
            console.error('Google token exchange failed', tokenData);
            return res.status(500).json({ error: 'token_exchange_failed', details: tokenData });
        }

        // Fetch userinfo
        const uiRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const userInfo = await uiRes.json();
        if (!userInfo || !userInfo.email) {
            console.error('Failed to fetch Google userinfo', userInfo);
            return res.status(500).json({ error: 'failed_fetch_userinfo', details: userInfo });
        }

        // Find or create user in local DB
        db.query('SELECT * FROM users WHERE email = ?', [userInfo.email], (err, rows) => {
            if (err) {
                console.error('DB lookup error during Google auth', err);
                return res.status(500).json({ error: 'db_error' });
            }

            const finishLogin = (user) => {
                try {
                    req.session.user = user;
                    req.session.userId = user.id;
                    const sid = req.sessionID;
                    const uid = String(user.id);
                    const set = userSessions.get(uid) || new Set();
                    set.add(sid);
                    userSessions.set(uid, set);
                    try { io.emit('admin:users:changed', { action: 'login', id: uid }); } catch (e) { console.error('Emit admin users changed error', e); }
                } catch (e) { console.error('Failed to finalize session for Google user', e); }
                return res.json({ success: true, redirect: '/dashboard' });
            };

            if (rows && rows.length > 0) {
                return finishLogin(rows[0]);
            }

            // Create new user with role 'agent' (change as needed)
            const name = userInfo.name || (userInfo.email || '').split('@')[0];
            const email = userInfo.email;
            const pw = Math.random().toString(36).slice(-12);
            const sql = isPg
                ? 'INSERT INTO users (name, email, password, role, disabled) VALUES (?, ?, ?, ?, 0) RETURNING id'
                : 'INSERT INTO users (name, email, password, role, disabled) VALUES (?, ?, ?, ?, 0)';
            db.query(sql, [name, email, pw, 'agent'], (insertErr, result) => {
                if (insertErr) {
                    console.error('Failed to create user from Google info', insertErr);
                    return res.status(500).json({ error: 'db_insert_failed', details: insertErr.message });
                }
                const newId = result.insertId;
                db.query('SELECT * FROM users WHERE id = ?', [newId], (err2, newRows) => {
                    if (err2 || !newRows || newRows.length === 0) {
                        console.error('Failed to fetch newly created Google user', err2);
                        return res.status(500).json({ error: 'db_fetch_failed' });
                    }
                    return finishLogin(newRows[0]);
                });
            });
        });

    } catch (e) {
        console.error('Unhandled error in /auth/google', e);
        return res.status(500).json({ error: 'internal', message: e.message });
    }
});

// Return public auth config (safe to expose client id)
app.get('/auth/config', (req, res) => {
    const id = process.env.GOOGLE_CLIENT_ID || null;
    if (!id) {
        console.warn('GET /auth/config - GOOGLE_CLIENT_ID not set');
        return res.status(500).json({ error: 'google_client_not_configured' });
    }
    console.log('GET /auth/config - returning google client id present');
    res.json({ googleClientId: id });
});

app.get("/dashboard", isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// Menu page removed

// Expose menu to frontend
app.get('/api/menu', (req, res) => {
    try {
        // Prefer DB-backed menu if available
        db.query('SELECT id, category, key_name, name, price, available, image_url FROM foods', (err, results) => {
            if (err) {
                console.error('GET /api/menu db error, falling back to in-memory MENU_ITEMS', err);
                return res.json(MENU_ITEMS || {});
            }
            if (!results || results.length === 0) return res.json(MENU_ITEMS || {});
            const out = {};
            for (const row of results) {
                const cat = row.category || 'other';
                out[cat] = out[cat] || {};
                out[cat][row.key_name] = { name: row.name, price: parseFloat(row.price), available: row.available, image_url: row.image_url };
            }
            res.json(out);
        });
    } catch (e) {
        console.error('GET /api/menu error', e);
        res.status(500).json({ error: 'internal' });
    }
});

// Return AI vs Staff message counts for the last 7 days (oldest -> newest)
app.get('/api/messages-last7', (req, res) => {
    try {
        const sql = isPg ? `
            SELECT DATE(created_at) AS dt,
                SUM(CASE WHEN LOWER(sender) ~ 'ai|bot|assistant' THEN 1 ELSE 0 END) AS ai_count,
                SUM(CASE WHEN (user_id IS NOT NULL OR LOWER(sender) ~ 'agent|staff|sent|sent_by_agent') THEN 1 ELSE 0 END) AS staff_count
            FROM (
                SELECT sender, created_at, NULL AS user_id FROM messages
                UNION ALL
                SELECT sender, created_at, user_id FROM replies
                UNION ALL
                SELECT sender, created_at, user_id FROM ai_messages
                UNION ALL
                SELECT sender, created_at, user_id FROM staff_messages
                UNION ALL
                SELECT sender, created_at, user_id FROM "ai replies"
                UNION ALL
                SELECT sender, created_at, user_id FROM "staff replies"
            ) AS all_msgs
            WHERE DATE(created_at) BETWEEN CURRENT_DATE - INTERVAL '6 days' AND CURRENT_DATE
            GROUP BY DATE(created_at)
            ORDER BY DATE(created_at)
        ` : `
            SELECT DATE(created_at) AS dt,
                SUM(CASE WHEN LOWER(sender) REGEXP 'ai|bot|assistant' THEN 1 ELSE 0 END) AS ai_count,
                SUM(CASE WHEN (user_id IS NOT NULL OR LOWER(sender) REGEXP 'agent|staff|sent|sent_by_agent') THEN 1 ELSE 0 END) AS staff_count
            FROM (
                SELECT sender, created_at, NULL AS user_id FROM messages
                UNION ALL
                SELECT sender, created_at, user_id FROM replies
                UNION ALL
                SELECT sender, created_at, user_id FROM ai_messages
                UNION ALL
                SELECT sender, created_at, user_id FROM staff_messages
                UNION ALL
                SELECT sender, created_at, user_id FROM \`ai replies\`
                UNION ALL
                SELECT sender, created_at, user_id FROM \`staff replies\`
            ) AS all_msgs
            WHERE DATE(created_at) BETWEEN DATE_SUB(CURDATE(), INTERVAL 6 DAY) AND CURDATE()
            GROUP BY DATE(created_at)
            ORDER BY DATE(created_at)
        `;

        db.query(sql, (err, rows) => {
            if (err) {
                console.error('/api/messages-last7 db error', err);
                return res.status(500).json({ error: 'DB error' });
            }

            // Build full 7-day array (oldest -> newest)
            const outAi = [];
            const outStaff = [];
            const labels = [];
            const map = {};
            (rows || []).forEach(r => { map[String(r.dt)] = r; });

            for (let i = 6; i >= 0; i--) {
                const d = new Date();
                d.setDate(d.getDate() - i);
                const key = d.toISOString().slice(0,10);
                labels.push((7 - i) + 'd');
                const row = map[key];
                outAi.push(row ? Number(row.ai_count || 0) : 0);
                outStaff.push(row ? Number(row.staff_count || 0) : 0);
            }

            res.json({ labels: labels, ai: outAi, staff: outStaff });
        });
    } catch (e) {
        console.error('GET /api/messages-last7 error', e);
        res.status(500).json({ error: 'internal' });
    }
});

// Simple in-memory tables simulation
const TABLES = [];
for (let i = 1; i <= 10; i++) {
    TABLES.push({ id: i, name: `Table ${i}`, seats: i <= 4 ? 4 : 6, status: 'available' });
}

function randomizeTableStates() {
    const states = ['available', 'occupied', 'reserved'];
    for (let t of TABLES) {
        // 25% chance to change state
        if (Math.random() < 0.25) {
            t.status = states[Math.floor(Math.random() * states.length)];
        }
    }
}

// Change table states every 5 seconds to simulate live updates
setInterval(randomizeTableStates, 5000);

app.get('/api/tables', (req, res) => {
    try {
        res.json(TABLES);
    } catch (e) {
        console.error('GET /api/tables error', e);
        res.status(500).json({ error: 'internal' });
    }
});

// Create foods table for menu persistence
if (isPg) {
    db.query(`
        CREATE TABLE IF NOT EXISTS foods (
            id INT AUTO_INCREMENT PRIMARY KEY,
            category VARCHAR(100) NOT NULL,
            key_name VARCHAR(100) NOT NULL,
            name VARCHAR(255) NOT NULL,
            price DECIMAL(10,2) NOT NULL DEFAULT 0,
            available INT NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `, (err) => {
        if (err) {
            console.error('Error creating foods table (pg):', err);
            return;
        }

        db.query('CREATE UNIQUE INDEX IF NOT EXISTS uk_category_key ON foods(category, key_name)', (ie) => {});
        db.query('SELECT COUNT(*) AS cnt FROM foods', (cErr, rows) => {
            if (cErr) return console.error('Error counting foods rows:', cErr);
            const cnt = rows && rows[0] ? rows[0].cnt : 0;
            if (cnt === 0) {
                const inserts = [];
                for (const [cat, items] of Object.entries(MENU_ITEMS || {})) {
                    for (const [key, it] of Object.entries(items)) {
                        inserts.push([cat, key, it.name || key, it.price || 0, it.available || 0]);
                    }
                }
                if (inserts.length > 0) {
                    const valuesClause = inserts.map((_, idx) => `($${idx*5+1}, $${idx*5+2}, $${idx*5+3}, $${idx*5+4}, $${idx*5+5})`).join(', ');
                    const flatParams = inserts.flat();
                    const upsertSql = `INSERT INTO foods (category, key_name, name, price, available) VALUES ${valuesClause} ON CONFLICT (category, key_name) DO UPDATE SET name = EXCLUDED.name, price = EXCLUDED.price, available = EXCLUDED.available`;
                    db.query(upsertSql, flatParams, (insErr) => {
                        if (insErr) console.error('Error seeding foods table:', insErr);
                        else console.log('Foods table seeded from MENU_ITEMS');
                    });
                }
            }
        });
    });
} else {
    db.query(`
        CREATE TABLE IF NOT EXISTS foods (
            id INT AUTO_INCREMENT PRIMARY KEY,
            category VARCHAR(100) NOT NULL,
            key_name VARCHAR(100) NOT NULL,
            name VARCHAR(255) NOT NULL,
            price DECIMAL(10,2) NOT NULL DEFAULT 0,
            available INT NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uk_category_key (category, key_name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `, (err) => {
        if (err) {
            console.error('Error creating foods table:', err);
            return;
        }

        db.query('SELECT COUNT(*) AS cnt FROM foods', (cErr, rows) => {
            if (cErr) return console.error('Error counting foods rows:', cErr);
            const cnt = rows && rows[0] ? rows[0].cnt : 0;
            if (cnt === 0) {
                const inserts = [];
                for (const [cat, items] of Object.entries(MENU_ITEMS || {})) {
                    for (const [key, it] of Object.entries(items)) {
                        inserts.push([cat, key, it.name || key, it.price || 0, it.available || 0]);
                    }
                }
                if (inserts.length > 0) {
                    db.query('INSERT INTO foods (category, key_name, name, price, available) VALUES ? ON DUPLICATE KEY UPDATE name=VALUES(name), price=VALUES(price), available=VALUES(available)', [inserts], (insErr) => {
                        if (insErr) console.error('Error seeding foods table:', insErr);
                        else console.log('Foods table seeded from MENU_ITEMS');
                    });
                }
            }
        });
    });
}

// Ensure foods table has image_url column
db.query("ALTER TABLE foods ADD COLUMN IF NOT EXISTS image_url TEXT NULL", (err) => {
    if (err && err.errno !== 1060) console.error('Error adding image_url to foods:', err);
});

// Upload image endpoint for menu images
app.post('/api/menu/upload', upload.single('image'), (req, res) => {
    try {
        if (!req.session || !req.session.user) return res.status(401).json({ error: 'not_logged_in' });
        if (!req.file) return res.status(400).json({ error: 'no_file' });
        // Return a URL that can be used as background
        const fileUrl = `/uploads/${req.file.filename}`;
        res.json({ success: true, url: fileUrl });
    } catch (e) {
        console.error('/api/menu/upload error', e);
        res.status(500).json({ error: 'internal' });
    }
});

// Upsert or add menu item
app.post('/api/menu/item', express.json(), (req, res) => {
    try {
        if (!req.session || !req.session.user) return res.status(401).json({ error: 'not_logged_in' });
        const { category, key, name, price, available, sumWithExisting, image_url } = req.body || {};
        if (!category || !key || !name) return res.status(400).json({ error: 'missing_fields' });
        const p = parseFloat(price || 0);
        const avail = parseInt(available || 0, 10) || 0;

        db.query('SELECT id, available FROM foods WHERE category = ? AND key_name = ? LIMIT 1', [category, key], (sErr, rows) => {
            if (sErr) return res.status(500).json({ error: 'db_error' });
            if (rows && rows.length > 0) {
                const existing = rows[0];
                const newAvailable = sumWithExisting ? (existing.available + avail) : avail;
                db.query('UPDATE foods SET name = ?, price = ?, available = ?, image_url = ? WHERE id = ?', [name, p, newAvailable, image_url || null, existing.id], (uErr) => {
                    if (uErr) return res.status(500).json({ error: 'db_error' });
                    return res.json({ success: true });
                });
            } else {
                db.query('INSERT INTO foods (category, key_name, name, price, available, image_url) VALUES (?, ?, ?, ?, ?, ?)', [category, key, name, p, avail, image_url || null], (iErr) => {
                    if (iErr) return res.status(500).json({ error: 'db_error' });
                    return res.json({ success: true });
                });
            }
        });
    } catch (e) {
        console.error('/api/menu/item error', e);
        res.status(500).json({ error: 'internal' });
    }
});

app.get("/logout", (req, res) => {
    try {
        const uid = req.session && req.session.userId ? String(req.session.userId) : null;
        if (uid && userSessions.has(uid)) {
            const set = userSessions.get(uid);
            set.delete(req.sessionID);
            if (set.size === 0) userSessions.delete(uid);
            else userSessions.set(uid, set);
        }
    } catch (e) { console.error('Error cleaning userSessions on logout', e); }
    try { const uid = req.session && req.session.userId ? String(req.session.userId) : null; req.session.destroy(() => { try { if (uid) io.emit('admin:users:changed', { action: 'logout', id: uid }); } catch (e) {} }); } catch (e) { req.session.destroy(); }
    res.redirect("/login.html");
});

// Health check route to verify DB connectivity
app.get('/health', (req, res) => {
    db.query('SELECT 1 AS ok', (qErr, rows) => {
        if (qErr) {
            console.error('Health check query error:', qErr);
            return res.status(500).json({ status: 'error', error: qErr.message });
        }
        res.json({ status: 'ok', rows });
    });
});

// ---------------------------
// User API
// ---------------------------
app.get("/api/user", (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: "Not logged in" });
    res.json({
        id: req.session.userId,
        name: req.session.user.name,
        role: req.session.user.role
    });
});

// Admin middleware
function isAdmin(req, res, next) {
    if (req.session && req.session.user && req.session.user.role === 'admin') return next();
    return res.status(403).json({ error: 'admin_required' });
}

// ---------------------------
// Admin: User management APIs
// ---------------------------
app.get('/api/admin/users', isAuthenticated, isAdmin, (req, res) => {
    db.query('SELECT id, name, email, role, disabled FROM users', (err, rows) => {
        if (err) return res.status(500).json({ error: 'db_error' });
        try {
            const augmented = rows.map(r => {
                const uid = String(r.id);
                const sessions = userSessions.get(uid);
                // check onlineAgents map for any socket with this userId
                let online = false;
                for (const a of onlineAgents.values()) {
                    if (String(a.userId) === uid) { online = true; break; }
                }
                return Object.assign({}, r, { active: !!(sessions && sessions.size > 0) || online });
            });
            res.json(augmented);
        } catch (e) {
            console.error('augment admin users error', e);
            res.json(rows);
        }
    });
});

app.post('/api/admin/users', isAuthenticated, isAdmin, (req, res) => {
    const { name, email, password, role } = req.body;
    console.log('POST /api/admin/users body=', req.body);
    if (!email || !password) return res.status(400).json({ error: 'email_and_password_required' });
    const sql = isPg
        ? 'INSERT INTO users (name, email, password, role, disabled) VALUES (?, ?, ?, ?, 0) RETURNING id'
        : 'INSERT INTO users (name, email, password, role, disabled) VALUES (?, ?, ?, ?, 0)';
    db.query(sql, [name || email.split('@')[0], email, password, role || 'agent'], (err, result) => {
        if (err) {
            console.error('Failed to insert user:', err);
            // return helpful error for client
            const payload = { error: 'db_error', code: err.code || null, message: err.sqlMessage || String(err) };
            return res.status(500).json(payload);
        }
        console.log('User created id=', result.insertId);
        try { io.emit('admin:users:changed', { action: 'create', id: result.insertId, email }); } catch (e) { console.error('Emit admin users changed error', e); }
        res.json({ success: true, id: result.insertId });
    });
});

app.put('/api/admin/users/:id', isAuthenticated, isAdmin, (req, res) => {
    const id = req.params.id;
    const { name, role, disabled } = req.body;
    const sql = 'UPDATE users SET name = COALESCE(?, name), role = COALESCE(?, role), disabled = COALESCE(?, disabled) WHERE id = ?';
    db.query(sql, [name, role, (disabled ? 1 : 0), id], (err) => {
        if (err) return res.status(500).json({ error: 'db_error' });
        try { io.emit('admin:users:changed', { action: 'update', id }); } catch (e) { console.error('Emit admin users changed error', e); }
        res.json({ success: true });
    });
});

app.delete('/api/admin/users/:id', isAuthenticated, isAdmin, (req, res) => {
    const id = req.params.id;
    db.query('DELETE FROM users WHERE id = ?', [id], (err) => {
        if (err) return res.status(500).json({ error: 'db_error' });
        // destroy tracked sessions
        try {
            const set = userSessions.get(String(id));
            if (set) {
                set.forEach(sid => {
                    // destroy session by id if possible
                    try { req.sessionStore.destroy(sid, () => {}); } catch (e) {}
                });
                userSessions.delete(String(id));
            }
        } catch (e) {}
        res.json({ success: true });
        try { io.emit('admin:users:changed', { action: 'delete', id }); } catch (e) { console.error('Emit admin users changed error', e); }
    });
});

app.post('/api/admin/users/:id/reset-password', isAuthenticated, isAdmin, (req, res) => {
    const id = req.params.id;
    const newPass = Math.random().toString(36).slice(-8);
    db.query('UPDATE users SET password = ? WHERE id = ?', [newPass, id], (err) => {
        if (err) return res.status(500).json({ error: 'db_error' });
        // Optionally email the password; here we just return it so admin can communicate it
        try { io.emit('admin:users:changed', { action: 'reset-password', id }); } catch (e) { console.error('Emit admin users changed error', e); }
        res.json({ success: true, password: newPass });
    });
});

app.post('/api/admin/users/:id/force-logout', isAuthenticated, isAdmin, (req, res) => {
    const id = req.params.id;
    try {
        const set = userSessions.get(String(id));
        if (set) {
            set.forEach(sid => {
                try { req.sessionStore.destroy(sid, () => {}); } catch (e) { console.error('destroy session error', e); }
            });
            userSessions.delete(String(id));
        }
    } catch (e) {
        console.error('force-logout error', e);
        return res.status(500).json({ error: 'internal' });
    }
    try { io.emit('admin:users:changed', { action: 'force-logout', id }); } catch (e) { console.error('Emit admin users changed error', e); }
    res.json({ success: true });
});

// ---------------------------
// Staff Metrics (mock/sample)
// ---------------------------
app.get('/api/staff-metrics', isAuthenticated, (req, res) => {
    // Real implementation: compute per-staff metrics from DB
    // We'll gather: id, name, messages_handled, avg_response_time (sec), avg_resolution_time (sec), last_week array

    // First get staff users (basic list)
    db.query("SELECT id, name FROM users", (err, users) => {
        if (err) {
            console.error('Error fetching users for metrics:', err);
            return res.status(500).json({ error: 'DB error' });
        }

        const tasks = users.map(u => {
            return new Promise((resolve) => {
                const out = { id: u.id, name: u.name, messages_handled: 0, avg_response_time: null, avg_resolution_time: null, satisfaction: null, last_week: [] };

                // messages handled
                db.query('SELECT COUNT(*) AS cnt FROM replies WHERE user_id = ?', [u.id], (err2, r2) => {
                    if (!err2 && r2 && r2[0]) out.messages_handled = r2[0].cnt || 0;

                    // avg response time: average seconds between the most recent customer message before a reply and the reply
                    const avgRespSql = `
                        SELECT AVG(TIMESTAMPDIFF(SECOND, m.prev_created, r.created_at)) AS avg_resp FROM (
                            SELECT r1.id, r1.conversation_id, r1.created_at
                            FROM replies r1
                            WHERE r1.user_id = ?
                        ) r
                        JOIN (
                            SELECT m1.conversation_id, m1.created_at AS prev_created
                            FROM messages m1
                        ) m ON m.conversation_id = r.conversation_id AND m.prev_created = (
                            SELECT MAX(m2.created_at) FROM messages m2 WHERE m2.conversation_id = r.conversation_id AND m2.created_at < r.created_at
                        )
                    `;

                    // Due to MySQL limitations with complex correlated subqueries in JOINs, we'll compute avg response using a simpler approach:
                    const avgRespFallback = `
                        SELECT AVG(TIMESTAMPDIFF(SECOND, (
                            SELECT MAX(m2.created_at) FROM messages m2 WHERE m2.conversation_id = r3.conversation_id AND m2.created_at < r3.created_at
                        ), r3.created_at)) AS avg_resp
                        FROM replies r3
                        WHERE r3.user_id = ? AND EXISTS (
                            SELECT 1 FROM messages m3 WHERE m3.conversation_id = r3.conversation_id AND m3.created_at < r3.created_at
                        )
                    `;

                    db.query(avgRespFallback, [u.id], (err3, r3) => {
                        if (!err3 && r3 && r3[0] && r3[0].avg_resp != null) out.avg_response_time = Math.round(r3[0].avg_resp);

                        // avg resolution time: approximate as average time from conversation creation to the last reply by this user in that conversation
                        const avgResSql = `
                            SELECT AVG(TIMESTAMPDIFF(SECOND, c.created_at, r4.created_at)) AS avg_res
                            FROM (
                                SELECT conversation_id, MAX(created_at) AS created_at
                                FROM replies
                                WHERE user_id = ?
                                GROUP BY conversation_id
                            ) r4
                            JOIN conversations c ON c.id = r4.conversation_id
                        `;
                        db.query(avgResSql, [u.id], (err4, r4) => {
                            if (!err4 && r4 && r4[0] && r4[0].avg_res != null) out.avg_resolution_time = Math.round(r4[0].avg_res);

                            // last_week: counts of replies by day (Mon..Sun) for the last 7 days
                            const lastWeekSql = isPg ? `
                                SELECT DATE(created_at) AS d, COUNT(*) AS cnt
                                FROM replies
                                WHERE user_id = ? AND created_at >= CURRENT_DATE - INTERVAL '7 days'
                                GROUP BY DATE(created_at)
                                ORDER BY DATE(created_at) ASC
                            ` : `
                                SELECT DATE(created_at) AS d, COUNT(*) AS cnt
                                FROM replies
                                WHERE user_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
                                GROUP BY DATE(created_at)
                                ORDER BY DATE(created_at) ASC
                            `;
                            db.query(lastWeekSql, [u.id], (err5, r5) => {
                                if (!err5 && r5) {
                                    // build last_week array of length up to 7
                                    const map = {};
                                    r5.forEach(rr => { 
                                        const key = (rr.d instanceof Date) ? rr.d.toISOString().slice(0,10) : (new Date(rr.d)).toISOString().slice(0,10);
                                        map[key] = rr.cnt; 
                                    });
                                    const arr = [];
                                    for (let i=6;i>=0;i--) {
                                        const d = new Date(); d.setDate(d.getDate() - i);
                                        const key = d.toISOString().slice(0,10);
                                        arr.push(map[key] || 0);
                                    }
                                    out.last_week = arr;
                                }

                                resolve(out);
                            });
                        });
                    });
                });
            });
        });

        Promise.all(tasks).then(results => res.json(results)).catch(e => {
            console.error('Metrics assembly error', e);
            res.status(500).json({ error: 'Failed to build metrics' });
        });
    });
});

// ---------------------------
// Settings API (per-user)
// ---------------------------
// Add columns if missing
db.query("ALTER TABLE settings ADD COLUMN IF NOT EXISTS translate_enabled TINYINT(1) DEFAULT 0", (err) => {
    if (err && err.errno !== 1060) console.log("Error adding translate_enabled to settings:", err);
});
db.query("ALTER TABLE settings ADD COLUMN IF NOT EXISTS translate_lang VARCHAR(10) DEFAULT 'en'", (err) => {
    if (err && err.errno !== 1060) console.log("Error adding translate_lang to settings:", err);
});
// Ensure settings table can store an avatar URL
db.query("ALTER TABLE settings ADD COLUMN IF NOT EXISTS avatar_url TEXT NULL", (err) => {
    if (err && err.errno !== 1060) console.log("Error adding avatar_url to settings:", err);
});
db.query("ALTER TABLE settings ADD COLUMN IF NOT EXISTS autopilotMode VARCHAR(20) DEFAULT 'assist'", (err) => {
    if (err && err.errno !== 1060) console.log("Error adding autopilotMode to settings:", err);
});

// Create user_avatars table to keep avatar history and metadata
if (isPg) {
    db.query(`
        CREATE TABLE IF NOT EXISTS user_avatars (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            filename VARCHAR(255) NOT NULL,
            url TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
    `, (err) => {
        if (err) console.error('Error creating user_avatars table (pg):', err);
        else db.query('CREATE INDEX IF NOT EXISTS idx_user_avatars_user_id ON user_avatars(user_id)', (ie) => {});
    });
} else {
    db.query(`
        CREATE TABLE IF NOT EXISTS user_avatars (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            filename VARCHAR(255) NOT NULL,
            url TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            INDEX idx_user_avatars_user_id (user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `, (err) => { if (err) console.error('Error creating user_avatars table:', err); });
}

app.get('/api/settings', isAuthenticated, (req, res) => {
    const userId = req.session.userId;
    db.query('SELECT * FROM settings WHERE user_id = ? LIMIT 1', [userId], (err, results) => {
        if (err) {
            console.error('GET /api/settings error', err);
            return res.status(500).json({ error: 'Database error' });
        }
        if (!results || results.length === 0) return res.json({});
        res.json(results[0]);
    });
});

app.post('/api/settings', isAuthenticated, (req, res) => {
    const userId = req.session.userId;
    const translate_enabled = req.body.translate_enabled ? 1 : 0;
    const translate_lang = req.body.translate_lang || 'en';

    const sql = isPg
        ? `INSERT INTO settings (user_id, translate_enabled, translate_lang) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET translate_enabled = EXCLUDED.translate_enabled, translate_lang = EXCLUDED.translate_lang`
        : `INSERT INTO settings (user_id, translate_enabled, translate_lang) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE translate_enabled = VALUES(translate_enabled), translate_lang = VALUES(translate_lang)`;
    db.query(sql, [userId, translate_enabled, translate_lang], (err) => {
        if (err) {
            console.error('POST /api/settings error', err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json({ success: true });
    });
});

// ---------------------------
// Conversations & Messages
// ---------------------------
app.get("/api/conversations", (req, res) => {
    if (req.query.id) {
        db.query("SELECT * FROM conversations WHERE id = ?", [req.query.id], (err, result) => {
            if (err) throw err;
            res.json(result);
        });
    } else {
        const primarySql = `
            SELECT c.*, 
                (SELECT COUNT(*) FROM messages m2 
                    WHERE m2.conversation_id = c.id 
                      AND LOWER(m2.sender) NOT IN ('sent', 'sent_by_agent')
                      AND (c.last_viewed IS NULL OR m2.created_at > c.last_viewed)
                ) AS unread_count
            FROM conversations c
            ORDER BY GREATEST(IFNULL((SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1), c.created_at), c.created_at) DESC
        `;

        // Try the primary query first. If it fails (e.g. missing `last_viewed` column on some databases),
        // fallback to a more compatible query that omits the last_viewed comparison.
        db.query(primarySql, (err, result) => {
            if (!err) {
                try {
                    const safe = JSON.parse(JSON.stringify(result, (_k, v) => typeof v === 'bigint' ? v.toString() : v));
                    return res.json(safe);
                } catch (e) {
                    console.warn('/api/conversations: failed to serialize result, converting bigints to strings', e && e.message);
                    const safe = result.map(r => {
                        const out = {};
                        Object.keys(r).forEach(k => {
                            const val = r[k];
                            out[k] = (typeof val === 'bigint') ? val.toString() : val;
                        });
                        return out;
                    });
                    return res.json(safe);
                }
            }

            console.warn('/api/conversations primary query failed, falling back to compatible query', err && err.message);

            const fallbackSql = `
                SELECT c.*, 
                    (SELECT COUNT(*) FROM messages m2 
                        WHERE m2.conversation_id = c.id 
                          AND LOWER(m2.sender) NOT IN ('sent', 'sent_by_agent')
                    ) AS unread_count
                FROM conversations c
                ORDER BY COALESCE((SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1), c.created_at) DESC
            `;

            db.query(fallbackSql, (err2, result2) => {
                if (err2) {
                    console.error('/api/conversations fallback query also failed', err2 && err2.message);
                    // As a last resort, try a very simple query that should be compatible with any schema
                    console.warn('/api/conversations attempting ultimate simple fallback query');
                    const ultimateSql = `SELECT id, phone, name, platform, created_at FROM conversations ORDER BY created_at DESC`;
                    db.query(ultimateSql, (err3, result3) => {
                        if (err3) {
                            console.error('/api/conversations ultimate fallback failed', err3 && err3.message);
                            return res.status(500).json({ error: 'Database error' });
                        }
                        try {
                            const safe3 = JSON.parse(JSON.stringify(result3, (_k, v) => typeof v === 'bigint' ? v.toString() : v));
                            return res.json(safe3);
                        } catch (e3) {
                            const safe3 = result3.map(r => {
                                const out = {};
                                Object.keys(r).forEach(k => {
                                    const val = r[k];
                                    out[k] = (typeof val === 'bigint') ? val.toString() : val;
                                });
                                return out;
                            });
                            return res.json(safe3);
                        }
                    });
                }
                try {
                    const safe2 = JSON.parse(JSON.stringify(result2, (_k, v) => typeof v === 'bigint' ? v.toString() : v));
                    return res.json(safe2);
                } catch (e2) {
                    const safe2 = result2.map(r => {
                        const out = {};
                        Object.keys(r).forEach(k => {
                            const val = r[k];
                            out[k] = (typeof val === 'bigint') ? val.toString() : val;
                        });
                        return out;
                    });
                    return res.json(safe2);
                }
            });
        });
    }
});

app.put('/api/conversations/viewed', isAuthenticated, (req, res) => {
    const { id } = req.body || {};
    if (!id) {
        return res.status(400).json({ success: false, error: 'Missing conversation id' });
    }
    const sql = isPg
        ? 'UPDATE conversations SET last_viewed = CURRENT_TIMESTAMP WHERE id = ?'
        : 'UPDATE conversations SET last_viewed = NOW() WHERE id = ?';
    db.query(sql, [id], (err) => {
        if (err) {
            console.error('PUT /api/conversations/viewed error', err);
            return res.status(500).json({ success: false, error: 'Database error' });
        }
        res.json({ success: true });
    });
});

app.put('/api/conversations', isAuthenticated, (req, res) => {
    const { id, name } = req.body || {};
    if (!id) {
        return res.status(400).json({ success: false, error: 'Missing conversation id' });
    }
    db.query('UPDATE conversations SET name = ? WHERE id = ?', [name || null, id], (err, result) => {
        if (err) {
            console.error('PUT /api/conversations error', err);
            return res.status(500).json({ success: false, error: 'Database error' });
        }
        res.json({ success: true });
    });
});

// Recent tickets endpoint used by dashboard (joins last message and status)
app.get('/api/recent-tickets', (req, res) => {
    const sql = `
        SELECT c.id, c.phone, c.name, c.platform, c.created_at,
            (SELECT m.message FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
            (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_at,
            (CASE
                WHEN EXISTS(SELECT 1 FROM resolved r WHERE r.conversation_id = c.id) THEN 'Resolved'
                WHEN EXISTS(SELECT 1 FROM escalations e WHERE e.conversation_id = c.id) THEN 'Escalated'
                ELSE 'Open'
            END) AS status
        FROM conversations c
        ORDER BY GREATEST(IFNULL((SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1), c.created_at), c.created_at) DESC
        LIMIT 20
    `;
    db.query(sql, (err, rows) => {
        if (err) {
            console.error('/api/recent-tickets db error', err);
            return res.status(500).json({ error: 'DB error' });
        }
        res.json(rows);
    });
});

    // Recent tickets widget for dashboard (reads from tickets table)
    app.get('/api/recent-tickets-tickets', (req, res) => {
        const sql = `
            SELECT id, subject, assignee, status, created_at, LEFT(content, 200) AS snippet
            FROM tickets
            ORDER BY created_at DESC
            LIMIT 4
        `;
        db.query(sql, (err, rows) => {
            if (err) {
                console.error('/api/recent-tickets-tickets db error', err);
                return res.status(500).json({ error: 'DB error' });
            }
            res.json(rows || []);
        });
    });

    // Recent customer messages for dashboard (last N customer messages)
    app.get('/api/recent-messages', (req, res) => {
        const limit = Math.min(100, parseInt(req.query.limit || '5', 10));
        const sql = `
            SELECT m.id, m.conversation_id, m.sender, m.message, m.created_at, c.name AS customer_name, c.phone
            FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
            WHERE m.sender IS NULL OR LOWER(m.sender) NOT IN ('sent','sent_by_agent') AND m.sender <> 'sent'
            ORDER BY m.created_at DESC
            LIMIT ?
        `;
        db.query(sql, [limit], (err, rows) => {
            if (err) {
                console.error('/api/recent-messages db error', err);
                return res.status(500).json({ error: 'DB error' });
            }
            res.json(rows || []);
        });
    });

// New endpoint: Instagram conversations (joined info)
app.get('/api/instagram/conversations', (req, res) => {
    const sql = `
        SELECT ic.conversation_id AS id, ic.ig_id, ic.ig_username, c.phone, c.name,
            (SELECT message FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
            (SELECT COUNT(*) FROM messages m2 WHERE m2.conversation_id = c.id AND m2.sender <> 'sent') AS unread_count,
            c.created_at
        FROM instagram_conversations ic
        JOIN conversations c ON c.id = ic.conversation_id
        ORDER BY c.created_at DESC
    `;
    db.query(sql, (err, rows) => {
        if (err) {
            console.error('/api/instagram/conversations db error', err);
            return res.status(500).json({ error: 'DB error' });
        }
        res.json(rows);
    });
});

app.get("/api/messages/:id", (req, res) => {
    const id = req.params.id;
    db.query(
        `SELECT sender, message, created_at FROM messages WHERE conversation_id = ? 
         UNION ALL
         SELECT sender, message, created_at FROM replies WHERE conversation_id = ? 
         ORDER BY created_at ASC`,
        [id, id],
        (err, result) => {
            if (err) throw err;
            res.json(result);
        }
    );
});

app.get("/api/suggest-reply/:id", async (req, res) => {
    const conversationId = req.params.id;
    try {
        db.query(
            "SELECT c.phone FROM conversations c WHERE c.id = ? LIMIT 1",
            [conversationId],
            async (err, convResult) => {
                if (err) {
                    console.error('Error fetching conversation phone for suggestion:', err);
                    return res.status(500).json({ suggestion: "Unable to create AI suggestion." });
                }

                const phone = convResult && convResult[0] ? convResult[0].phone : null;
                db.query(
                    "SELECT message FROM messages WHERE conversation_id = ? AND sender != 'sent' ORDER BY created_at DESC LIMIT 1",
                    [conversationId],
                    async (err2, msgResult) => {
                        if (err2) {
                            console.error('Error fetching latest customer message for suggestion:', err2);
                            return res.status(500).json({ suggestion: "Unable to create AI suggestion." });
                        }

                        const latestCustomerMessage = msgResult && msgResult[0] ? msgResult[0].message : null;
                        if (!latestCustomerMessage) {
                            return res.json({ suggestion: "No customer message yet to suggest a reply." });
                        }

                        const suggestion = await getMistralReply(latestCustomerMessage, phone, conversationId);
                        return res.json({ suggestion });
                    }
                );
            }
        );
    } catch (error) {
        console.error('Suggestion endpoint error:', error);
        res.status(500).json({ suggestion: "Unable to create AI suggestion." });
    }
});

// ---------------------------
// Send Message (Agent)
// ---------------------------
async function sendAutoReply(phone, message) {
    try {
        const token = await getWhatsAppToken();
        const response = await fetch(
            `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
            {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${token}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    messaging_product: "whatsapp",
                    to: phone,
                    type: "text",
                    text: { body: message }
                })
            }
        );

        // (previously emitted a playHandoffAudio event for some AI replies; removed per request)

        const data = await response.json();
        console.log("Auto-reply sent:", data);

        if (!response.ok || (data && data.error)) {
            throw new Error(JSON.stringify({ status: response.status, data }));
        }

        const conversation_id = await getOrCreateConversationByPhone(phone);
        db.query(
            "INSERT INTO replies (conversation_id, sender, message, user_id, created_at) VALUES (?, ?, ?, ?, NOW())",
            [conversation_id, 'sent', message, null],
            (err) => {
                if (err) {
                    console.log("AUTO-REPLY INSERT ERROR:", err);
                } else {
                    const messageData = {
                        conversation_id,
                        sender: "sent",
                        message,
                        created_at: new Date().toISOString()
                    };
                    io.emit("newMessage", messageData);
                }
            }
        );
    } catch (error) {
        console.log("AUTO-REPLY ERROR:", error);
    }
}

function getOrCreateConversationByPhone(phone, platform = 'whatsapp') {
    return new Promise((resolve, reject) => {
        if (!phone) return reject(new Error('Missing phone'));

        db.query("SELECT id FROM conversations WHERE phone = ?", [phone], (err, result) => {
            if (err) return reject(err);
            if (result && result.length > 0) {
                return resolve(result[0].id);
            }

            const insertSql = isPg
                ? 'INSERT INTO conversations (phone, name, platform) VALUES (?, ?, ?) RETURNING id'
                : "INSERT INTO conversations (phone, name, platform) VALUES (?, ?, 'whatsapp')";

            db.query(insertSql, [phone, phone, platform], (insertErr, insertResult) => {
                if (insertErr) return reject(insertErr);
                const newId = isPg
                    ? (insertResult?.rows?.[0]?.id || insertResult?.[0]?.id)
                    : insertResult.insertId;
                if (!newId) return reject(new Error('Failed to create conversation'));
                resolve(newId);
            });
        });
    });
}

// ---------------------------
// Instagram Messaging Integration
// Requires env: INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_ACCOUNT_ID, INSTAGRAM_VERIFY_TOKEN
// ---------------------------
const IG_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN || null;
const IG_ACCOUNT_ID = process.env.INSTAGRAM_ACCOUNT_ID || null;
const IG_VERIFY_TOKEN = process.env.INSTAGRAM_VERIFY_TOKEN || 'livesupport_verify';

// Webhook verification endpoint for Meta (Instagram)
app.get('/webhook/instagram', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode && token) {
        if (mode === 'subscribe' && token === IG_VERIFY_TOKEN) {
            console.log('✅ Instagram webhook verified');
            return res.status(200).send(challenge);
        } else {
            return res.sendStatus(403);
        }
    }
    res.sendStatus(400);
});

// Webhook receiver for Instagram messaging events
app.post('/webhook/instagram', (req, res) => {
    const body = req.body;
    if (body && body.object) {
        // Example structure: body.entry[].messaging[] or body.entry[].changes
        try {
            const entries = body.entry || [];
            entries.forEach(entry => {
                const changes = entry.changes || [];
                // Newer IG events appear in changes array
                if (changes.length) {
                    changes.forEach(change => {
                        const value = change.value || {};
                        // messages may be under value.messages
                        const messages = value.messages || [];
                        messages.forEach(async (m) => {
                            const senderId = m.from || m.sender || (value && value.sender_id) || null;
                            const text = (m.text && m.text.body) || m.text || null;
                            if (!senderId) return;

                            // Upsert conversation by external id
                            db.query('SELECT id FROM conversations WHERE phone = ? OR name = ? LIMIT 1', [senderId, senderId], (err, rows) => {
                                if (err) return console.error('Instagram webhook DB lookup error', err);
                                if (rows && rows.length > 0) {
                                        const convId = rows[0].id;
                                        db.query('INSERT INTO messages (conversation_id, sender, message, created_at) VALUES (?, ?, ?, NOW())', [convId, 'instagram', text || '[non-text]'], (iErr) => {
                                            if (iErr) console.error('Error inserting IG message', iErr);
                                            else {
                                                io.emit('newMessage', { conversation_id: convId, sender: 'instagram', message: text, created_at: new Date().toISOString() });
                                                // Check for automated ticket creation
                                                checkAndCreateTicket(convId, senderId, text);
                                            }
                                        });
                                        // ensure instagram_conversations has a record for this conv
                                        db.query('SELECT id FROM instagram_conversations WHERE conversation_id = ? LIMIT 1', [convId], (icErr, icRows) => {
                                            if (icErr) return console.error('instagram_conversations lookup error', icErr);
                                            if (!icRows || icRows.length === 0) {
                                                db.query('INSERT INTO instagram_conversations (conversation_id, ig_id, ig_username) VALUES (?, ?, ?)', [convId, senderId, (value && value.from && value.from.username) || null], (insErr) => {
                                                    if (insErr) console.error('Error inserting instagram_conversations link', insErr);
                                                });
                                            }
                                        });
                                    } else {
                                        // create conversation
                                        const insertSql = isPg
                    ? 'INSERT INTO conversations (phone, name, platform, created_at) VALUES (?, ?, ?, NOW()) RETURNING id'
                    : 'INSERT INTO conversations (phone, name, platform, created_at) VALUES (?, ?, ?, NOW())';
                db.query(insertSql, [senderId, senderId, 'instagram'], (cErr, result) => {
                    if (cErr) return console.error('Error creating IG conversation', cErr);
                    const newId = result.insertId;
                    db.query('INSERT INTO messages (conversation_id, sender, message, created_at) VALUES (?, ?, ?, NOW())', [newId, 'instagram', text || '[non-text]'], (mErr) => {
                        if (mErr) console.error('Error inserting IG message after create', mErr);
                        else io.emit('newMessage', { conversation_id: newId, sender: 'instagram', message: text, created_at: new Date().toISOString() });
                    });
                    // create instagram_conversations link
                    db.query('INSERT INTO instagram_conversations (conversation_id, ig_id, ig_username) VALUES (?, ?, ?)', [newId, senderId, (value && value.from && value.from.username) || null], (insErr) => {
                        if (insErr) console.error('Error inserting instagram_conversations after conv create', insErr);
                    });
                });
                                    }
                            });
                        });
                    });

                        // Create AI/staff split message tables (MySQL)
                        db.query(`
                            CREATE TABLE IF NOT EXISTS ai_messages (
                                id INT AUTO_INCREMENT PRIMARY KEY,
                                conversation_id INT,
                                sender VARCHAR(255),
                                message TEXT,
                                user_id INT,
                                created_at DATETIME DEFAULT NOW()
                            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
                        `, (err) => { if (err) console.error('Error creating ai_messages table:', err); else console.log('ai_messages table ensured'); });

                        db.query(`
                            CREATE TABLE IF NOT EXISTS staff_messages (
                                id INT AUTO_INCREMENT PRIMARY KEY,
                                conversation_id INT,
                                sender VARCHAR(255),
                                message TEXT,
                                user_id INT,
                                created_at DATETIME DEFAULT NOW()
                            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
                        `, (err) => { if (err) console.error('Error creating staff_messages table:', err); else console.log('staff_messages table ensured'); });
                        // Create tables with spaces in their names as requested
                        db.query(`
                            CREATE TABLE IF NOT EXISTS \`ai replies\` (
                                id INT AUTO_INCREMENT PRIMARY KEY,
                                conversation_id INT,
                                sender VARCHAR(255),
                                message TEXT,
                                user_id INT,
                                created_at DATETIME DEFAULT NOW()
                            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
                        `, (err) => { if (err) console.error('Error creating ai replies table:', err); else console.log('`ai replies` table ensured'); });

                        db.query(`
                            CREATE TABLE IF NOT EXISTS \`staff replies\` (
                                id INT AUTO_INCREMENT PRIMARY KEY,
                                conversation_id INT,
                                sender VARCHAR(255),
                                message TEXT,
                                user_id INT,
                                created_at DATETIME DEFAULT NOW()
                            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
                        `, (err) => { if (err) console.error('Error creating staff replies table:', err); else console.log('`staff replies` table ensured'); });
                }
                // legacy messaging field handling
                if (entry.messaging && entry.messaging.length) {
                    entry.messaging.forEach(async (event) => {
                        if (event.message) {
                            const senderId = (event.sender && (event.sender.id || event.sender.user_id)) || event.from || null;
                            const text = event.message.text || null;
                            if (!senderId) return;
                            db.query('SELECT id FROM conversations WHERE phone = ? OR name = ? LIMIT 1', [senderId, senderId], (err, rows) => {
                                if (err) return console.error('Instagram webhook DB lookup error', err);
                                if (rows && rows.length > 0) {
                                    const convId = rows[0].id;
                                    db.query('INSERT INTO messages (conversation_id, sender, message, created_at) VALUES (?, ?, ?, NOW())', [convId, 'instagram', text || '[non-text]'], (iErr) => {
                                        if (iErr) console.error('Error inserting IG message', iErr);
                                        else io.emit('newMessage', { conversation_id: convId, sender: 'instagram', message: text, created_at: new Date().toISOString() });
                                    });
                                    db.query('SELECT id FROM instagram_conversations WHERE conversation_id = ? LIMIT 1', [convId], (icErr, icRows) => {
                                        if (icErr) return console.error('instagram_conversations lookup error', icErr);
                                        if (!icRows || icRows.length === 0) {
                                            db.query('INSERT INTO instagram_conversations (conversation_id, ig_id, ig_username) VALUES (?, ?, ?)', [convId, senderId, (event && event.sender && event.sender.username) || null], (insErr) => {
                                                if (insErr) console.error('Error inserting instagram_conversations link', insErr);
                                            });
                                        }
                                    });
                                } else {
                                    const insertSql = isPg
                                        ? 'INSERT INTO conversations (phone, name, platform, created_at) VALUES (?, ?, ?, NOW()) RETURNING id'
                                        : 'INSERT INTO conversations (phone, name, platform, created_at) VALUES (?, ?, ?, NOW())';
                                    db.query(insertSql, [senderId, senderId, 'instagram'], (cErr, result) => {
                                        if (cErr) return console.error('Error creating IG conversation', cErr);
                                        const newId = result.insertId;
                                        db.query('INSERT INTO messages (conversation_id, sender, message, created_at) VALUES (?, ?, ?, NOW())', [newId, 'instagram', text || '[non-text]'], (mErr) => {
                                            if (mErr) console.error('Error inserting IG message after create', mErr);
                                            else io.emit('newMessage', { conversation_id: newId, sender: 'instagram', message: text, created_at: new Date().toISOString() });
                                        });
                                        db.query('INSERT INTO instagram_conversations (conversation_id, ig_id, ig_username) VALUES (?, ?, ?)', [newId, senderId, (event && event.sender && event.sender.username) || null], (insErr) => {
                                            if (insErr) console.error('Error inserting instagram_conversations after conv create', insErr);
                                        });
                                    });
                                }
                            });
                        }
                    });
                }
            });
        } catch (err) {
            console.error('Instagram webhook processing error', err);
        }

        // Respond quickly to Meta
        return res.status(200).send('EVENT_RECEIVED');
    }
    // Not a page subscription
    return res.sendStatus(404);
});

    // OAuth: Redirect user to Facebook/Instagram for login
    app.get('/auth/instagram', (req, res) => {
        const clientId = process.env.INSTAGRAM_APP_ID;
        const redirectBase = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
        const redirectUri = `${redirectBase}/auth/instagram/callback`;
        if (!clientId) return res.status(500).send('Missing INSTAGRAM_APP_ID in .env');
        const scope = encodeURIComponent('instagram_basic,instagram_manage_messages,pages_manage_metadata');
        const authUrl = `https://www.facebook.com/v17.0/dialog/oauth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&response_type=code`;
        res.redirect(authUrl);
    });

    // OAuth callback: exchange code for access token and store it
    app.get('/auth/instagram/callback', async (req, res) => {
        const code = req.query.code;
        const clientId = process.env.INSTAGRAM_APP_ID;
        const clientSecret = process.env.INSTAGRAM_APP_SECRET;
        const redirectBase = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
        const redirectUri = `${redirectBase}/auth/instagram/callback`;
        if (!code) return res.status(400).send('Missing code');
        if (!clientId || !clientSecret) return res.status(500).send('Missing INSTAGRAM_APP_ID or INSTAGRAM_APP_SECRET in .env');

        try {
            // Exchange code for short-lived token
            const tokenUrl = `https://graph.facebook.com/v17.0/oauth/access_token?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${clientSecret}&code=${code}`;
            const tokenResp = await fetch(tokenUrl);
            const tokenData = await tokenResp.json();
            if (!tokenResp.ok) {
                console.error('Error exchanging code:', tokenData);
                return res.status(500).send('Token exchange failed: ' + JSON.stringify(tokenData));
            }
            const shortLived = tokenData.access_token;

            // Exchange for long-lived token
            const exchangeUrl = `https://graph.facebook.com/v17.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${clientId}&client_secret=${clientSecret}&fb_exchange_token=${encodeURIComponent(shortLived)}`;
            const exchResp = await fetch(exchangeUrl);
            const exchData = await exchResp.json();
            if (!exchResp.ok) {
                console.error('Error exchanging token for long-lived:', exchData);
                // still store short-lived as fallback
                storeInstagramToken(shortLived, tokenData.expires_in || null);
                return res.send('Stored short-lived token (long-lived exchange failed).');
            }
            const longToken = exchData.access_token;
            const expiresIn = exchData.expires_in || null;
            storeInstagramToken(longToken, expiresIn);

            // Optionally set environment var at runtime (only for this process)
            process.env.INSTAGRAM_ACCESS_TOKEN = longToken;

            res.send('<html><body><h3>Instagram login successful.</h3><p>Token saved. You may close this window.</p></body></html>');
        } catch (err) {
            console.error('OAuth callback error', err);
            res.status(500).send('OAuth callback error');
        }
    });

// Endpoint for sending messages via Instagram Graph API (agent action)
app.post('/api/instagram/send', isAuthenticated, async (req, res) => {
    const { recipient, message } = req.body; // recipient: instagram user id or external id
    if (!recipient || (!message && !req.body.attachment)) return res.status(400).json({ error: 'Missing recipient or message/attachment.' });
    if (!IG_ACCESS_TOKEN || !IG_ACCOUNT_ID) return res.status(500).json({ error: 'Instagram not configured. Set INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_ACCOUNT_ID in .env.' });

    try {
        const url = `https://graph.facebook.com/v17.0/${IG_ACCOUNT_ID}/messages`;
        const body = { recipient: { id: recipient }, message: {} };
        if (message) body.message.text = message;
        if (req.body.attachment) body.message.attachment = req.body.attachment; // pass-through attachment object (type/url)

        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${IG_ACCESS_TOKEN}` },
            body: JSON.stringify(body)
        });
        const data = await resp.json();

        // Store outgoing message in DB (map recipient -> conversation)
        db.query('SELECT id FROM conversations WHERE phone = ? OR name = ? LIMIT 1', [recipient, recipient], (err, rows) => {
            if (err) console.error('IG send DB lookup error', err);
            const doInsert = (convId) => {
                db.query('INSERT INTO replies (conversation_id, sender, message, created_at) VALUES (?, ?, ?, NOW())', [convId, 'sent', message || '[attachment]'], (iErr) => {
                    if (iErr) console.error('Error inserting IG outgoing reply', iErr);
                    else io.emit('newMessage', { conversation_id: convId, sender: 'sent', message: message || '[attachment]', created_at: new Date().toISOString() });
                });
            };
            if (rows && rows.length > 0) doInsert(rows[0].id);
            else {
                const insertSql = isPg
                    ? 'INSERT INTO conversations (phone, name, platform, created_at) VALUES (?, ?, ?, NOW()) RETURNING id'
                    : 'INSERT INTO conversations (phone, name, platform, created_at) VALUES (?, ?, ?, NOW())';
                db.query(insertSql, [recipient, recipient, 'instagram'], (cErr, result) => {
                    if (cErr) console.error('Error creating conv for IG send', cErr);
                    else doInsert(result.insertId);
                });
            }
        });

        res.json({ success: true, data });
    } catch (error) {
        console.error('Error sending Instagram message', error);
        res.status(500).json({ error: 'Failed to send message via Instagram.' });
    }
});

function isOrderConfirmation(text) {
    const confirmKeywords = ['yes', 'yep', 'yup', 'confirm', 'ok', 'okay', 'sure', 'go', 'order it', 'proceed', 'do it'];
    const lowerText = text.toLowerCase().trim();
    return confirmKeywords.some(keyword => lowerText.includes(keyword));
}

function findMostRecentCustomerOrderMessage(messages) {
    const orderKeywords = ['pizza', 'burger', 'cheese burger', 'cheese burgers', 'large pizzas', 'large pizza', 'meal', 'combo', 'sandwich', 'taco', 'drink', 'food', 'package', 'fries', 'salad', 'sushi', 'pasta', 'rice', 'noodles', 'wrap'];
    for (const msg of messages) {
        if (msg.sender === 'received' || msg.sender === 'customer') {
            const messageText = String(msg.message || '').trim();
            const lowerText = messageText.toLowerCase();

            // Skip responses that are just confirmations, rejections, or short support replies.
            if (isOrderConfirmation(lowerText) || /^\s*(yes|no|yep|nope|sure|ok|okay|please|confirm|cancel|thanks?)\s*$/.test(lowerText)) {
                continue;
            }

            if (orderKeywords.some(keyword => lowerText.includes(keyword))) {
                return messageText;
            }
        }
    }
    return null;
}

function cleanOrderText(text) {
    if (!text) return text;
    return String(text)
        .replace(/(?:let me know if you'd like to make any changes|please let me know if you'd like to make any changes|if you'd like to make any changes.*|let me know if.*)/gi, '')
        .replace(/\s+$/g, '')
        .trim();
}

const MENU_PRICES = {
    pizza: { small: 10, medium: 15, large: 20 },
    burger: { classic: 8, cheese: 9, double: 12 }
};

function parseNumberWord(str) {
    if (!str) return 1;
    const num = parseInt(str, 10);
    if (!isNaN(num)) return num;
    const numberWords = {
        one: 1, two: 2, three: 3, four: 4, five: 5,
        six: 6, seven: 7, eight: 8, nine: 9, ten: 10
    };
    return numberWords[str.toLowerCase()] || 1;
}

function parseMenuOrderText(text) {
    if (!text) return { items: null, total: 0 };

    const lowerText = text.toLowerCase();
    const counts = { pizza: 0, burger: 0 };
    let total = 0;

    const pizzaPattern = /(\d+|one|two|three|four|five|six|seven|eight|nine|ten)?\s*(small|medium|large)\s*pizzas?\b/gi;
    let pizzaMatch;
    while ((pizzaMatch = pizzaPattern.exec(lowerText)) !== null) {
        const quantity = parseNumberWord(pizzaMatch[1]);
        const size = pizzaMatch[2];
        counts.pizza += quantity;
        total += quantity * MENU_PRICES.pizza[size];
    }

    const burgerPattern = /(\d+|one|two|three|four|five|six|seven|eight|nine|ten)?\s*(classic|cheese|double)\s*burgers?\b/gi;
    let burgerMatch;
    while ((burgerMatch = burgerPattern.exec(lowerText)) !== null) {
        const quantity = parseNumberWord(burgerMatch[1]);
        const type = burgerMatch[2];
        counts.burger += quantity;
        total += quantity * MENU_PRICES.burger[type];
    }

    if (counts.pizza === 0) {
        const genericPizzaPattern = /(\d+|one|two|three|four|five|six|seven|eight|nine|ten)?\s*pizzas?\b/gi;
        let genericPizzaMatch;
        while ((genericPizzaMatch = genericPizzaPattern.exec(lowerText)) !== null) {
            const quantity = parseNumberWord(genericPizzaMatch[1]);
            counts.pizza += quantity;
            total += quantity * MENU_PRICES.pizza.medium;
        }
    }

    if (counts.burger === 0) {
        const genericBurgerPattern = /(\d+|one|two|three|four|five|six|seven|eight|nine|ten)?\s*burgers?\b/gi;
        let genericBurgerMatch;
        while ((genericBurgerMatch = genericBurgerPattern.exec(lowerText)) !== null) {
            const quantity = parseNumberWord(genericBurgerMatch[1]);
            counts.burger += quantity;
            total += quantity * MENU_PRICES.burger.cheese;
        }
    }

    if (counts.pizza === 0 && counts.burger === 0) {
        return { items: null, total: 0 };
    }

    const itemParts = [];
    if (counts.pizza > 0) itemParts.push(`${counts.pizza} ${counts.pizza === 1 ? 'pizza' : 'pizzas'}`);
    if (counts.burger > 0) itemParts.push(`${counts.burger} ${counts.burger === 1 ? 'burger' : 'burgers'}`);

    return {
        items: itemParts.join(', '),
        total
    };
}

function extractOrderDetails(aiMessage, customerMessage = null) {
    const cleanCustomerMessage = cleanOrderText(customerMessage || '');
    const cleanAiMessage = cleanOrderText(aiMessage || '');

    const customerParsed = parseMenuOrderText(cleanCustomerMessage);
    const aiParsed = parseMenuOrderText(cleanAiMessage);

    // Extract explicit total from AI confirmation text first, then fallback to customer order text.
    const explicitTotal = extractOrderTotal(cleanAiMessage) || extractOrderTotal(cleanCustomerMessage);

    let total = explicitTotal || 0;
    if (customerParsed.total > 0) {
        if (!total || customerParsed.total !== total) {
            total = customerParsed.total;
        }
    } else if (aiParsed.total > 0 && !total) {
        total = aiParsed.total;
    }

    // Extract product information from customer order text first.
    let items = extractOrderItems(cleanCustomerMessage) || extractOrderItems(cleanAiMessage) || customerParsed.items || aiParsed.items;

    // Only use raw fallback as last resort, and only if it's a real customer order message
    if (!items && cleanCustomerMessage && /(pizza|burger|meal|combo|sandwich|taco|drink|food|fries|salad|sushi|pasta|rice|noodles|wrap)/i.test(cleanCustomerMessage)) {
        const shortMessage = cleanCustomerMessage.substring(0, 100);
        items = shortMessage.length > 3 ? shortMessage : null;
    }

    items = String(items || 'Order').trim();
    if (!items || items.length < 2) items = 'Order';

    return { items, total };
}

function extractOrderTotal(text) {
    if (!text) return null;
    const totalMatch = text.match(/\$(\d+(?:\.\d+)?)/);
    if (totalMatch) return parseFloat(totalMatch[1]);

    const totalAlt = text.match(/(?:total|comes to|is|amount|cost|price)\s*[:]?\s*\$?\s*(\d+(?:\.\d+)?)/i);
    return totalAlt ? parseFloat(totalAlt[1]) : null;
}

function extractOrderItems(text) {
    if (!text) return null;

    // Try specific order statement patterns first
    const itemPatterns = [
        /(?:i(?:'d| would)? like to order|i(?:'d| would)? like|i want to order|i want|can i get|please order|send me|i need|order|give me|add|deliver)\s+(.+?)(?:\s+(?:for|comes to|total|totals?|cost|price|amount)|\s*\$|\s*\(|$)/i,
        /(?:my order is|please can i have|please may i have)\s+(.+?)(?:\s+(?:for|comes to|total|totals?|cost|price|amount)|\s*\$|\s*\(|$)/i
    ];

    for (const pattern of itemPatterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
            let itemText = match[1].trim();
            // Remove trailing phrases
            itemText = itemText.replace(/\s*(?:please|thanks|thank you|ok|okay).*$/i, '').trim();
            if (itemText && !/^yes|no|ok|okay|sure|confirm|cancel$/i.test(itemText) && itemText.length > 2) {
                return itemText;
            }
        }
    }

    // If patterns don't match, try to extract just the food items using a different approach
    const lowerText = text.toLowerCase();
    if (/(pizza|burger|meal|combo|sandwich|taco|drink|food|fries|salad|sushi|pasta|rice|noodles|wrap)/i.test(lowerText)) {
        // Extract quantity + food items pattern: "3 Cheese Burgers", "Large Pizza", etc.
        const foodPattern = /(\d+\s+)?(?:large|small|medium|extra|with)?\s*([a-zA-Z\s&]+(?:pizza|burger|meal|combo|sandwich|taco|drink|food|fries|salad|sushi|pasta|rice|noodles|wrap)[a-zA-Z\s&]*)/gi;
        const foodMatches = text.match(foodPattern);
        
        if (foodMatches && foodMatches.length > 0) {
            // Join all matched food items
            return foodMatches.map(item => item.trim()).join(', ');
        }

        // If pattern still doesn't work, extract up to the price marker
        const beforePrice = text.split(/\$|total|comes to|for a total|cost/i)[0];
        if (beforePrice && beforePrice.length < text.length - 5) {
            let cleaned = beforePrice.trim()
                .replace(/^(?:i(?:'d|'m)?\s+(?:want|like|need|order|order me|please|please order)\s+)/i, '')
                .replace(/\s*(?:please|thanks|thank you)\s*$/i, '')
                .trim();
            if (cleaned && cleaned.length > 2) {
                return cleaned;
            }
        }
    }

    return null;
}

function getConversationCustomerName(conversationId) {
    return new Promise((resolve) => {
        db.query('SELECT name FROM conversations WHERE id = ? LIMIT 1', [conversationId], (err, results) => {
            if (err || !results || results.length === 0) {
                resolve('Customer');
            } else {
                resolve(results[0].name || 'Customer');
            }
        });
    });
}

async function checkAndSaveOrderConfirmation(phone, conversationId, customerMessage) {
    if (!isOrderConfirmation(customerMessage)) {
        return false;
    }

    return new Promise(async (resolve) => {
        // Get last few messages to find AI's order suggestion
        db.query(
            `SELECT sender, message, created_at FROM messages WHERE conversation_id = ?
             UNION ALL
             SELECT sender, message, created_at FROM replies WHERE conversation_id = ?
             ORDER BY created_at DESC LIMIT 10`,
            [conversationId, conversationId],
            async (err, messages) => {
                if (err || !messages || messages.length === 0) {
                    resolve(false);
                    return;
                }

                // Find the AI's most recent message (sender = 'sent')
                const aiMessage = messages.find(m => m.sender === 'sent');
                if (!aiMessage) {
                    resolve(false);
                    return;
                }

                const customerOrderMessage = findMostRecentCustomerOrderMessage(messages);
                const { items, total } = extractOrderDetails(aiMessage.message, customerOrderMessage);

                if (!total || total === 0) {
                    console.log("Order confirmation detected but no valid order total found in AI message or customer order message:", {
                        aiMessage: aiMessage.message,
                        customerOrderMessage
                    });
                    resolve(false);
                    return;
                }

                const customerName = await getConversationCustomerName(conversationId);
                const orderId = `ORD-${Date.now()}`;
                const product = items;
                const amount = total;
                const status = 'confirmed';

                db.query(
                    'INSERT INTO orders (order_id, customer_name, phone, product, amount, total_amount, status, order_date, conversation_id) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?)',
                    [orderId, customerName, phone || null, product, amount, total, status, conversationId],
                    (err, result) => {
                        if (err) {
                            console.log("Order save error:", err);
                            resolve(false);
                        } else {
                            console.log(`Order confirmed and saved: ${product} - $${total} from ${phone}`);
                            // Emit order-created so connected dashboards update immediately
                            try {
                                const orderPayload = {
                                    id: orderId,
                                    customerName: customerName,
                                    product: product,
                                    amount: amount,
                                    status: status,
                                    date: new Date().toLocaleDateString()
                                };
                                if (typeof io !== 'undefined') io.emit('order-created', orderPayload);
                            } catch (emitErr) {
                                console.error('Failed to emit order-created for AI-created order', emitErr);
                            }
                            // Automatically start delivery simulation for this newly created order
                            try {
                                startDeliverySimulationForOrder(orderId, (startErr, rider) => {
                                    if (startErr) {
                                        console.error('Auto-start delivery failed for order', orderId, startErr);
                                    } else {
                                        console.log('Auto-started delivery for order', orderId, 'rider:', rider && rider.name);
                                    }
                                });
                            } catch (ex) {
                                console.error('Exception while auto-starting delivery for order', orderId, ex);
                            }

                            resolve(true);
                        }
                    }
                );
            }
        );
    });
}

app.post("/api/send-message", async (req, res) => {
    let { conversation_id, message, phone } = req.body;

    if (!message) {
        return res.status(400).json({ error: "Missing message." });
    }

    if (!conversation_id && phone) {
        try {
            conversation_id = await getOrCreateConversationByPhone(phone);
        } catch (err) {
            console.error("Failed to create conversation for phone:", phone, err);
            return res.status(500).json({ error: "Unable to create conversation." });
        }
    }

    if (!conversation_id) {
        return res.status(400).json({ error: "Missing conversation_id or phone." });
    }

    disableAIForConversation(conversation_id);
    console.log(`📤 Staff message detected for conversation ${conversation_id}, disabling AI immediately`);

    db.query("SELECT phone FROM conversations WHERE id = ?", [conversation_id], async (err, result) => {
        if (err) return res.sendStatus(500);
        if (!result || result.length === 0) {
            if (phone) {
                try {
                    conversation_id = await getOrCreateConversationByPhone(phone);
                } catch (createErr) {
                    console.error("Failed to create conversation by phone fallback:", createErr);
                    return res.status(500).json({ error: "Conversation not found." });
                }
            } else {
                return res.send("Conversation not found");
            }
        }

        const targetPhone = result && result.length > 0 ? result[0].phone : phone;
        if (!targetPhone) {
            return res.status(400).json({ error: "Missing phone for sending message." });
        }

        try {
            console.log("Sending WhatsApp message", { conversation_id, targetPhone, message: message.slice(0, 120) });
            const token = await getWhatsAppToken();
            const response = await fetch(
                `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
                {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${token}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        messaging_product: "whatsapp",
                        to: targetPhone,
                        type: "text",
                        text: { body: message }
                    })
                }
            );

            const data = await response.json();
            console.log("WhatsApp response:", data);

            if (!response.ok || (data && data.error)) {
                console.error("WhatsApp API send-message error:", response.status, data);
                return res.status(response.ok ? 500 : response.status).json({ error: data.error || data || 'WhatsApp API error' });
            }

            // Save to DB
            db.query(
                "INSERT INTO replies (conversation_id, sender, message, user_id, created_at) VALUES (?, ?, ?, ?, NOW())",
                [conversation_id, 'sent', message, req.session ? req.session.userId : null],
                (err) => {
                    if (err) {
                        console.log("MESSAGE INSERT ERROR:", err);
                        return res.status(500).send("Message save failed");
                    }

                    const messageData = {
                        conversation_id,
                        sender: "sent",
                        message,
                        created_at: new Date().toISOString()
                    };

                    // Emit via Socket.IO
                    io.emit("newMessage", messageData);
                    res.json({ success: true, message: messageData });
                }
            );

        } catch (error) {
            console.log("SEND ERROR:", error);
            res.status(500).json({ error: error.message || 'Send error' });
        }
    });
});

app.post("/api/send-media", upload.single("file"), (req, res) => {
    const { conversation_id, caption } = req.body;
    const file = req.file;
    if (!conversation_id || !file) {
        if (file && file.path) fs.unlink(file.path, () => {});
        return res.status(400).json({ error: "Missing conversation or file." });
    }

    disableAIForConversation(conversation_id);

    db.query("SELECT phone FROM conversations WHERE id = ?", [conversation_id], async (err, result) => {
        if (err) {
            if (file.path) fs.unlink(file.path, () => {});
            return res.sendStatus(500);
        }
        if (!result || result.length === 0) {
            if (file.path) fs.unlink(file.path, () => {});
            return res.status(404).json({ error: "Conversation not found" });
        }

        const phone = result[0].phone;

        try {
            const fileBuffer = await fs.promises.readFile(file.path);
            const boundary = "----WhatsAppFormBoundary" + Date.now();
            const parts = [];

            parts.push(Buffer.from(`--${boundary}\r\n`));
            parts.push(Buffer.from(`Content-Disposition: form-data; name="messaging_product"\r\n\r\n`));
            parts.push(Buffer.from(`whatsapp\r\n`));

            parts.push(Buffer.from(`--${boundary}\r\n`));
            parts.push(Buffer.from(`Content-Disposition: form-data; name="type"\r\n\r\n`));
            parts.push(Buffer.from(`${file.mimetype}\r\n`));

            parts.push(Buffer.from(`--${boundary}\r\n`));
            parts.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="${file.originalname}"\r\n`));
            parts.push(Buffer.from(`Content-Type: ${file.mimetype}\r\n\r\n`));
            parts.push(fileBuffer);
            parts.push(Buffer.from(`\r\n`));
            parts.push(Buffer.from(`--${boundary}--\r\n`));

            const multipartBody = Buffer.concat(parts);
            const token = await getWhatsAppToken();
            const uploadResponse = await fetch(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/media`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": `multipart/form-data; boundary=${boundary}`
                },
                body: multipartBody
            });

            const uploadData = await uploadResponse.json();
            if (!uploadResponse.ok || !uploadData.id) {
                throw new Error(JSON.stringify(uploadData));
            }

            const mediaId = uploadData.id;
            const mediaType = file.mimetype.startsWith("image/") ? "image" : "document";
            const messageBody = {
                messaging_product: "whatsapp",
                to: phone,
                type: mediaType,
                [mediaType]: { id: mediaId }
            };

            if (caption) {
                messageBody[mediaType].caption = caption;
            }
            if (mediaType === "document") {
                messageBody[mediaType].filename = file.originalname;
            }

            const sendResponse = await fetch(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(messageBody)
            });

            const sendData = await sendResponse.json();
            if (!sendResponse.ok) {
                throw new Error(JSON.stringify(sendData));
            }

            const savedMessage = caption ? `${caption} [file: ${file.originalname}]` : `[file: ${file.originalname}]`;
            db.query(
                "INSERT INTO replies (conversation_id, sender, message, user_id, created_at) VALUES (?, ?, ?, ?, NOW())",
                [conversation_id, 'sent', savedMessage, req.session ? req.session.userId : null],
                (err) => {
                    if (file.path) fs.unlink(file.path, () => {});
                    if (err) {
                        console.log("MESSAGE INSERT ERROR:", err);
                        return res.status(500).json({ error: "Message save failed" });
                    }

                    const messageData = {
                        conversation_id,
                        sender: "sent",
                        message: savedMessage,
                        created_at: new Date().toISOString()
                    };

                    io.emit("newMessage", messageData);
                    res.json({ success: true, message: messageData });
                }
            );
        } catch (error) {
            console.log("SEND MEDIA ERROR:", error);
            if (file.path) fs.unlink(file.path, () => {});
            res.status(500).json({ error: "Failed to send media." });
        }
    });
});

// ---------------------------
// Customer Webhook
// ---------------------------
app.post("/webhook", async (req, res) => {
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const phone = msg.from;
    let text = msg.text?.body || "";
    const sender = msg.from === process.env.PHONE_NUMBER_ID ? 'sent' : 'received';

    // Handle audio messages
    if (msg.audio && !text) {
        try {
            const audioId = msg.audio.id;
            const token = await getWhatsAppToken();
            const audioResponse = await fetch(`https://graph.facebook.com/v18.0/${audioId}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            const audioData = await audioResponse.json();
            if (audioData.url) {
                // Download audio file
                const audioFetch = await fetch(audioData.url, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                const audioBuffer = await audioFetch.arrayBuffer();

                // Transcribe audio (placeholder - in production use Google Speech-to-Text)
                text = await transcribeAudio(audioBuffer);
                console.log(`🎵 Transcribed audio: "${text}"`);
            }
        } catch (error) {
            console.error('Audio transcription error:', error);
            text = "[Audio message - transcription failed]";
        }
    }

    console.log(`\n📩 WEBHOOK MESSAGE RECEIVED:`, {
        phone,
        text,
        sender,
        msgFrom: msg.from,
        phoneNumberId: process.env.PHONE_NUMBER_ID,
        isSent: msg.from === process.env.PHONE_NUMBER_ID,
        hasAudio: !!msg.audio
    });

    db.query("SELECT * FROM conversations WHERE phone = ?", [phone], async (err, result) => {
        if (err) return console.log("🔥 REAL DB ERROR:", err);

        if (!result || result.length === 0) {
            // Create new conversation
            const insertConvSql = isPg
                ? 'INSERT INTO conversations (phone, name, platform) VALUES (?, ?, ?) RETURNING id'
                : "INSERT INTO conversations (phone, name, platform) VALUES (?, ?, 'whatsapp')";
            db.query(insertConvSql, [phone, phone, 'whatsapp'], async (err, newConv) => {
                if (err) return console.log("INSERT ERROR:", err);
                const convoId = newConv.insertId;
                const targetTable = sender === 'sent' ? 'replies' : 'messages';
                const query = `INSERT INTO ${targetTable} (conversation_id, sender, message, created_at) VALUES (?, ?, ?, NOW())`;
                db.query(
                    query,
                    [convoId, sender, text],
                    async (err) => {
                        if (err) console.log("MESSAGE INSERT ERROR:", err);
                        else {
                            io.emit("newMessage", {
                                conversation_id: convoId,
                                sender: sender,
                                message: text,
                                created_at: new Date().toISOString()
                            });

                            // If this is an agent message, disable AI responses
                            if (sender === 'sent') {
                                disableAIForConversation(convoId);
                                console.log(`Agent message received, AI disabled for conversation ${convoId}`);
                            } else {
                                if (isCustomerGreeting(text) && isStaffIdleForThreeMinutes(convoId)) {
                                    enableAIForConversation(convoId);
                                }
                                // Only process customer messages for AI response
                                // Check if this is an order confirmation
                                const orderConfirmed = await checkAndSaveOrderConfirmation(phone, convoId, text);
                                if (orderConfirmed) {
                                    await sendAutoReply(phone, "Your order has been confirmed an your order is now being prepared for delivery🚚✅");
                                } else {
                                    const forceAI = isTicketCreationRequest(text) || isRequestingStaff(text);
                                    if (forceAI || shouldAIRespond(convoId)) {
                                        const reply = await getMistralReply(text, phone, convoId);
                                        await sendAutoReply(phone, reply);
                                    } else {
                                        console.log(`AI response skipped for conversation ${convoId} - agent recently active`);
                                    }
                                }
                            }

                            // Auto-escalate if refund is mentioned
                            if (text && text.toLowerCase().includes("refund")) {
                                db.query("INSERT INTO escalations (conversation_id, customer_name) VALUES (?, ?)", [convoId, phone], (err) => {
                                    if (err) console.log("ESCALATION INSERT ERROR:", err);
                                });
                            }

                            // Check for automated ticket creation
                            if (sender !== 'sent') {
                                checkAndCreateTicket(convoId, phone, text);
                            }
                        }
                    }
                );
            });
        } else {
            const convoId = result[0].id;
            db.query(
                "INSERT INTO messages (conversation_id, sender, message, created_at) VALUES (?, ?, ?, NOW())",
                [convoId, sender, text],
                async (err) => {
                    if (err) console.log("MESSAGE INSERT ERROR:", err);
                    else {
                        io.emit("newMessage", {
                            conversation_id: convoId,
                            sender: sender,
                            message: text,
                            created_at: new Date().toISOString()
                        });

                        // If this is an agent message, disable AI responses
                        if (sender === 'sent') {
                            disableAIForConversation(convoId);
                            console.log(`Agent message received, AI disabled for conversation ${convoId}`);
                        } else {
                            if (isCustomerGreeting(text)) {
                                enableAIForConversation(convoId);
                            }
                            // Only process customer messages for AI response
                            // Check if this is an order confirmation
                            const orderConfirmed = await checkAndSaveOrderConfirmation(phone, convoId, text);
                            if (orderConfirmed) {
                                await sendAutoReply(phone, "Your order has been confirmed an your order is now being prepared for delivery🚚✅");
                            } else {
                                const forceAI = isTicketCreationRequest(text) || isRequestingStaff(text);
                                if (forceAI || shouldAIRespond(convoId)) {
                                    const reply = await getMistralReply(text, phone, convoId);
                                    await sendAutoReply(phone, reply);
                                } else {
                                    console.log(`AI response skipped for conversation ${convoId} - agent recently active`);
                                }
                            }
                        }

                        if (text && text.toLowerCase().includes("refund")) {
                            db.query("INSERT INTO escalations (conversation_id, customer_name) VALUES (?, ?)", [convoId, phone], (err) => {
                                if (err) console.log("ESCALATION INSERT ERROR:", err);
                            });
                        }

                        // Check for automated ticket creation
                        if (sender !== 'sent') {
                            checkAndCreateTicket(convoId, phone, text);
                        }
                    }
                }
            );
        }
    });

    res.sendStatus(200);
});

// ---------------------------
// Test endpoint to simulate incoming message
// ---------------------------
// POST /api/test-message?phone=1234567890&message=Hello
app.post("/api/test-message", (req, res) => {
    const phone = req.query.phone || "1234567890";
    const text = req.query.message || "Test message";

    db.query("SELECT * FROM conversations WHERE phone = ?", [phone], async (err, result) => {
        if (err) return res.sendStatus(500);

        if (!result || result.length === 0) {
            // Create new conversation
            const insertConvSql = isPg
                ? 'INSERT INTO conversations (phone, name, platform) VALUES (?, ?, ?) RETURNING id'
                : "INSERT INTO conversations (phone, name, platform) VALUES (?, ?, 'whatsapp')";
            db.query(insertConvSql, [phone, phone, 'whatsapp'], (err, newConv) => {
                if (err) return res.sendStatus(500);
                const convoId = newConv.insertId;
                db.query(
                    "INSERT INTO messages (conversation_id, sender, message, created_at) VALUES (?, 'customer', ?, NOW())",
                    [convoId, text],
                    async (err) => {
                        if (err) return res.sendStatus(500);
                        const messageData = {
                            conversation_id: convoId,
                            sender: "received",
                            message: text,
                            created_at: new Date().toISOString()
                        };
                        io.emit("newMessage", messageData);

                        // Check if this is an order confirmation
                        const orderConfirmed = await checkAndSaveOrderConfirmation(phone, convoId, text);
                        if (orderConfirmed) {
                            await sendAutoReply(phone, "Your order has been confirmed an your order is now being prepared for delivery🚚✅");
                        } else {
                            // Check if AI should respond
                            if (shouldAIRespond(convoId)) {
                                const reply = await getMistralReply(text, phone, convoId);
                                await sendAutoReply(phone, reply);
                            } else {
                                console.log(`AI response skipped for conversation ${convoId} - agent recently active`);
                            }
                        }
                        res.json({ success: true, conversation_id: convoId });
                    }
                );
            });
        } else {
            const convoId = result[0].id;
            db.query(
                "INSERT INTO messages (conversation_id, sender, message, created_at) VALUES (?, 'customer', ?, NOW())",
                [convoId, text],
                async (err) => {
                    if (err) return res.sendStatus(500);
                    const messageData = {
                        conversation_id: convoId,
                        sender: "received",
                        message: text,
                        created_at: new Date().toISOString()
                    };
                    io.emit("newMessage", messageData);

                    if (isCustomerGreeting(text) && isStaffIdleForThreeMinutes(convoId)) {
                        enableAIForConversation(convoId);
                    }
                    const orderConfirmed = await checkAndSaveOrderConfirmation(phone, convoId, text);
                    if (orderConfirmed) {
                        await sendAutoReply(phone, "Your order has been confirmed an your food is now being prepared for delivery🚚✅");
                    } else {
                        const forceAI = isTicketCreationRequest(text) || isRequestingStaff(text);
                        if (forceAI || shouldAIRespond(convoId)) {
                            const reply = await getMistralReply(text, phone, convoId);
                            await sendAutoReply(phone, reply);
                        } else {
                            console.log(`AI response skipped for conversation ${convoId} - agent recently active`);
                        }
                    }
                    res.json({ success: true, conversation_id: convoId });
                }
            );
        }
    });
});

// ---------------------------
// Webhook GET for verification
// ---------------------------
app.get("/webhook", (req, res) => {
    const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode && token === VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.sendStatus(403);
});

// ---------------------------
// Receipts
// ---------------------------
app.post("/api/receipts", (req, res) => {
    const { content } = req.body;
    const insertSql = isPg
        ? 'INSERT INTO receipts (content) VALUES (?) RETURNING id'
        : 'INSERT INTO receipts (content) VALUES (?)';
    db.query(insertSql, [content], (err, result) => {
        if (err) {
            console.error('Error inserting receipt:', err);
            return res.status(500).json({ error: 'Failed to save receipt' });
        }
        const receipt = {
            id: result.insertId,
            content,
            created_at: new Date().toISOString()
        };
        // Emit a socket event so any connected dashboard can display an update instantly
        io.emit("receiptCreated", receipt);
        res.json({ id: result.insertId, success: true });
    });
});

app.get("/api/receipts", (req, res) => {
    db.query("SELECT * FROM receipts ORDER BY created_at DESC", (err, results) => {
        if (err) {
            console.error('Error fetching receipts:', err);
            return res.status(500).json({ error: 'Failed to fetch receipts' });
        }
        res.json(results);
    });
});

// Delete receipt
app.delete("/api/receipts/:id", (req, res) => {
    const { id } = req.params;
    db.query("DELETE FROM receipts WHERE id = ?", [id], (err) => {
        if (err) {
            console.error('Error deleting receipt:', err);
            return res.status(500).json({ error: 'Failed to delete receipt' });
        }
        io.emit("receiptDeleted", { id: Number(id) });
        res.json({ success: true });
    });
});

// ---------------------------
// Tickets
// ---------------------------
// Multipart handler for file uploads from ticket modal (registered first so multer handles multipart requests)
app.post('/api/tickets', upload.array('files'), (req, res, next) => {
    // multer will populate req.body (text fields) and req.files
    if (!req.files || req.files.length === 0) return next();
    try{
        const { ticket_type, subject, customer_name, customer_phone, assignee, priority, status, content, tags } = req.body || {};
        const tagsText = tags ? (Array.isArray(tags) ? JSON.stringify(tags) : tags) : null;
        const slaDue = req.body.sla_due ? new Date(req.body.sla_due) : computeSlaDue(assignee, ticket_type);
        const attachments = (req.files || []).map(f => ({ originalname: f.originalname, filename: f.filename, path: f.path, size: f.size }));
        const insertSql = isPg
            ? `INSERT INTO tickets (ticket_type, subject, customer_name, customer_phone, assignee, priority, status, content, tags, attachments, sla_due) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
            : `INSERT INTO tickets (ticket_type, subject, customer_name, customer_phone, assignee, priority, status, content, tags, attachments, sla_due) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        db.query(
            insertSql,
            [ticket_type || null, subject || null, customer_name || null, customer_phone || null, assignee || null, priority || null, status || 'Open', content || null, tagsText, JSON.stringify(attachments), slaDue],
            (err, result) => {
                if (err) {
                    console.error('Error inserting ticket with attachments:', err);
                    return res.status(500).json({ error: 'Failed to save ticket' });
                }
                const ticket = { id: result.insertId, ticket_type: ticket_type || null, subject, customer_name, customer_phone, assignee, priority, status: status || 'Open', content, tags: tagsText, attachments, sla_due: slaDue.toISOString(), created_at: new Date().toISOString() };
                io.emit('ticketCreated', ticket);
                res.json({ id: result.insertId, success: true });
            }
        );
    }catch(err){
        console.error('Multipart ticket handler error', err);
        res.status(500).json({ error: 'Failed to save ticket' });
    }
});

// JSON handler for tickets (no files)
app.post("/api/tickets", (req, res) => {
    // Accept richer ticket fields from the dashboard modal (JSON submission)
    const { ticket_type, subject, customer_name, customer_phone, assignee, priority, status, content, tags } = req.body || {};
    const tagsText = Array.isArray(tags) ? JSON.stringify(tags) : (tags || null);
    const slaDue = req.body.sla_due ? new Date(req.body.sla_due) : computeSlaDue(assignee, ticket_type);
    const insertSql = isPg
        ? `INSERT INTO tickets (ticket_type, subject, customer_name, customer_phone, assignee, priority, status, content, tags, sla_due) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
        : `INSERT INTO tickets (ticket_type, subject, customer_name, customer_phone, assignee, priority, status, content, tags, sla_due) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    db.query(
        insertSql,
        [ticket_type || null, subject || null, customer_name || null, customer_phone || null, assignee || null, priority || null, status || 'Open', content || null, tagsText, slaDue],
        (err, result) => {
            if (err) {
                console.error('Error inserting ticket:', err);
                return res.status(500).json({ error: 'Failed to save ticket' });
            }
            const ticket = {
                id: result.insertId,
                ticket_type: ticket_type || null,
                subject: subject || null,
                customer_name: customer_name || null,
                customer_phone: customer_phone || null,
                assignee: assignee || null,
                priority: priority || null,
                status: status || 'Open',
                content: content || null,
                tags: tagsText,
                sla_due: slaDue.toISOString(),
                created_at: new Date().toISOString(),
                escalated: 0
            };
            io.emit("ticketCreated", ticket);
            res.json({ id: result.insertId, success: true });
        }
    );
});

app.get("/api/tickets", (req, res) => {
    db.query("SELECT * FROM tickets ORDER BY created_at DESC", (err, results) => {
        if (err) {
            console.error('Error fetching tickets:', err);
            return res.status(500).json({ error: 'Failed to fetch tickets' });
        }
        res.json(results);
    });
});

app.delete("/api/tickets/:id", (req, res) => {
    const { id } = req.params;
    db.query("DELETE FROM tickets WHERE id = ?", [id], (err) => {
        if (err) {
            console.error('Error deleting ticket:', err);
            return res.status(500).json({ error: 'Failed to delete ticket' });
        }
        io.emit("ticketDeleted", { id: Number(id) });
        res.json({ success: true });
    });
});

// Bulk delete tickets by IDs
app.post('/api/tickets/delete', (req, res) => {
    const ids = req.body && req.body.ids ? req.body.ids : null;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'No ids provided' });
    // ensure numeric ids
    const nums = ids.map(i => Number(i)).filter(n => !Number.isNaN(n));
    if (nums.length === 0) return res.status(400).json({ error: 'No valid ids' });
    const placeholders = nums.map(() => '?').join(',');
    db.query(`DELETE FROM tickets WHERE id IN (${placeholders})`, nums, (err, result) => {
        if (err) {
            console.error('Error bulk deleting tickets:', err);
            return res.status(500).json({ error: 'Failed to delete tickets' });
        }
        // emit an event for each deleted id
        nums.forEach(id => io.emit('ticketDeleted', { id }));
        res.json({ success: true, deleted: result.affectedRows });
    });
});

// ---------------------------
// Escalate Ticket
// ---------------------------
app.post("/api/escalate-ticket", (req, res) => {
    const { ticket_id } = req.body;
    db.query("UPDATE tickets SET escalated = 1 WHERE id = ?", [ticket_id], (err) => {
        if (err) {
            console.error('Error escalating ticket:', err);
            return res.status(500).json({ error: 'Failed to escalate ticket' });
        }
        io.emit("ticketEscalated", { ticket_id });
        res.json({ success: true });
    });
});

// ---------------------------
// Resolve Ticket
// ---------------------------
app.post("/api/resolve-ticket", (req, res) => {
    const { ticket_id } = req.body;
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'not_logged_in' });
    const resolverName = req.session.user && req.session.user.name ? req.session.user.name : 'Staff';
    db.query("UPDATE tickets SET status = 'Resolved', sla_due = NULL WHERE id = ?", [ticket_id], (err) => {
        if (err) {
            console.error('Error resolving ticket:', err);
            return res.status(500).json({ error: 'Failed to resolve ticket' });
        }
        io.emit("ticketResolved", { ticket_id, resolved_by: resolverName });
        res.json({ success: true, resolved_by: resolverName });
    });
});

// ---------------------------
// Broadcast a staff notification to other online agents (excluding the sender)
// ---------------------------
app.post('/api/broadcast-notification', (req, res) => {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'not_logged_in' });
    const message = req.body && req.body.message ? String(req.body.message) : '';
    const from = req.session.user && req.session.user.name ? req.session.user.name : 'Staff';
    const payload = { message, from, time: new Date().toISOString() };

    try{
        // Send to all connected onlineAgents except the sender
        const recipients = [];
        for (const [socketId, rec] of onlineAgents.entries()){
            try{
                if (String(rec.userId) === String(req.session.userId)) continue; // skip sender
                io.to(socketId).emit('staffNotification', payload);
                recipients.push({ socketId, userId: rec.userId, name: rec.name });
            }catch(e){ console.error('notify emit error to', socketId, e); }
        }
        console.log('Broadcast notification from', from, 'message="' + message + '" sent to', recipients.length, 'recipients');
        if (recipients.length) console.log('Recipients:', recipients);
        res.json({ success: true, recipients: recipients.length });
    }catch(e){
        console.error('Broadcast notification error', e);
        res.status(500).json({ error: 'broadcast_failed' });
    }
});

// ---------------------------
// Escalate Receipt
// ---------------------------
app.post("/api/escalate-receipt", (req, res) => {
    const { receipt_id } = req.body;
    db.query("UPDATE receipts SET escalated = 1 WHERE id = ?", [receipt_id], (err) => {
        if (err) {
            console.error('Error escalating receipt:', err);
            return res.status(500).json({ error: 'Failed to escalate receipt' });
        }
        io.emit("receiptEscalated", { receipt_id });
        res.json({ success: true });
    });
});

// ---------------------------
// Escalations
// ---------------------------
app.post("/api/escalate", (req, res) => {
    const { conversation_id, name } = req.body;
    const checkSql = "SELECT * FROM escalations WHERE conversation_id = ?";
    db.query(checkSql, [conversation_id], (err, result) => {
        if (result.length > 0) return res.json({ success: true, message: "Already escalated" });

        const insertSql = "INSERT INTO escalations (conversation_id, customer_name) VALUES (?, ?)";
        db.query(insertSql, [conversation_id, name], (err) => {
            if (err) return res.status(500).send("DB error");
            res.json({ success: true });
        });
    });
});

// Claim an escalation (staff accepts the conversation)
app.post('/api/claim-escalation', (req, res) => {
    const { conversation_id, staff_name } = req.body;
    const sql = "UPDATE escalations SET claimed_by = ?, claim_time = CURRENT_TIMESTAMP, alarm_active = 0 WHERE conversation_id = ?";
    db.query(sql, [staff_name || null, conversation_id], (err) => {
        if (err) return res.status(500).json({ error: 'DB error' });
        // clear any existing snooze timers
        if (escalationTimers.has(conversation_id)) {
            clearTimeout(escalationTimers.get(conversation_id));
            escalationTimers.delete(conversation_id);
        }
        io.emit('escalationClaimed', { conversation_id, claimed_by: staff_name });
        io.emit('stopAlarm', { conversation_id });
        res.json({ success: true });
    });
});

// Snooze an escalation for N seconds (stop alarm temporarily)
app.post('/api/snooze-escalation', (req, res) => {
    const { conversation_id, staff_name, seconds } = req.body;
    const snoozeSeconds = Number(seconds) || 60;
    const updateSql = "UPDATE escalations SET snoozed_until = DATE_ADD(NOW(), INTERVAL ? SECOND), alarm_active = 0 WHERE conversation_id = ?";
    db.query(updateSql, [snoozeSeconds, conversation_id], (err) => {
        if (err) return res.status(500).json({ error: 'DB error' });
        // clear any existing timer first
        if (escalationTimers.has(conversation_id)) {
            clearTimeout(escalationTimers.get(conversation_id));
            escalationTimers.delete(conversation_id);
        }
        // set timer to reactivate alarm after snooze
        const t = setTimeout(() => {
            // Reactivate alarm if still not claimed
            db.query('SELECT claimed_by FROM escalations WHERE conversation_id = ?', [conversation_id], (qErr, rows) => {
                if (qErr) return console.log('Error checking claimed status after snooze:', qErr);
                if (rows && rows[0] && !rows[0].claimed_by) {
                    db.query('UPDATE escalations SET alarm_active = 1, snoozed_until = NULL WHERE conversation_id = ?', [conversation_id], (uErr) => {
                        if (uErr) return console.log('Error reactivating escalation alarm:', uErr);
                        io.emit('escalationRaised', { conversationId: conversation_id });
                        io.emit('handoffAlert', { conversationId: conversation_id });
                    });
                }
            });
            escalationTimers.delete(conversation_id);
        }, snoozeSeconds * 1000);
        escalationTimers.set(conversation_id, t);

        io.emit('escalationSnoozed', { conversation_id, by: staff_name, seconds: snoozeSeconds });
        io.emit('stopAlarm', { conversation_id });
        res.json({ success: true });
    });
});

app.get("/api/escalations", (req, res) => {
    db.query(`
        SELECT e.*, c.phone, c.name, c.created_at
        FROM escalations e
        JOIN conversations c ON e.conversation_id = c.id
        ORDER BY e.escalated_at DESC
    `, (err, results) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json(results);
    });
});

app.delete("/api/escalate/:conversation_id", (req, res) => {
    const convoId = req.params.conversation_id;
    db.query("DELETE FROM escalations WHERE conversation_id = ?", [convoId], (err) => {
        if (err) return res.status(500).send("DB error");
        res.json({ success: true });
    });
});

// Resolve escalation
app.post("/api/resolve", (req, res) => {
    const { conversation_id } = req.body;
    // Delete from escalations
    db.query("DELETE FROM escalations WHERE conversation_id = ?", [conversation_id], (err) => {
        if (err) return res.status(500).json({ error: "DB error" });
        // Insert into resolved
        db.query("INSERT INTO resolved (conversation_id) VALUES (?)", [conversation_id], (err) => {
            if (err) return res.status(500).json({ error: "DB error" });
            res.json({ success: true });
        });
    });
});

app.get("/api/resolved", (req, res) => {
    db.query(`
        SELECT r.*, c.phone, c.name, c.created_at
        FROM resolved r
        JOIN conversations c ON r.conversation_id = c.id
        ORDER BY r.resolved_at DESC
    `, (err, results) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json(results);
    });
});

app.post("/api/refund", (req, res) => {
    const { conversation_id, name } = req.body;
    db.query("DELETE FROM escalations WHERE conversation_id = ?", [conversation_id], (err) => {
        if (err) return res.status(500).json({ error: "DB error" });
        db.query("INSERT INTO resolved (conversation_id) VALUES (?)", [conversation_id], (resolvedErr) => {
            if (resolvedErr) {
                console.warn('Resolved insert failed, continuing to refund insert:', resolvedErr);
            }
            db.query(
                "INSERT INTO refunds (conversation_id, customer_name) VALUES (?, ?)",
                [conversation_id, name || null],
                (err) => {
                    if (err) return res.status(500).json({ error: "DB error" });
                    res.json({ success: true });
                }
            );
        });
    });
});

app.post("/api/delivery-issue", (req, res) => {
    const { conversation_id, name } = req.body;
    db.query("DELETE FROM escalations WHERE conversation_id = ?", [conversation_id], (err) => {
        if (err) return res.status(500).json({ error: "DB error" });
        db.query("INSERT INTO resolved (conversation_id) VALUES (?)", [conversation_id], (resolvedErr) => {
            if (resolvedErr) {
                console.warn('Resolved insert failed, continuing to delivery insert:', resolvedErr);
            }
            db.query(
                "INSERT INTO delivery_issues (conversation_id, customer_name) VALUES (?, ?)",
                [conversation_id, name || null],
                (err) => {
                    if (err) return res.status(500).json({ error: "DB error" });
                    res.json({ success: true });
                }
            );
        });
    });
});

app.get("/api/refunds", (req, res) => {
    db.query(`
        SELECT f.*, c.phone, c.name, c.platform
        FROM refunds f
        LEFT JOIN conversations c ON f.conversation_id = c.id
        ORDER BY f.refunded_at DESC
    `, (err, results) => {
        if (err) {
            console.error('Refunds query error:', err);
            return res.status(500).json({ error: err.message || "Database error" });
        }
        res.json(results);
    });
});

app.get("/api/delivery-issues", (req, res) => {
    db.query(`
        SELECT d.*, c.phone, c.name, c.platform
        FROM delivery_issues d
        LEFT JOIN conversations c ON d.conversation_id = c.id
        ORDER BY d.reported_at DESC
    `, (err, results) => {
        if (err) {
            console.error('Delivery issues query error:', err);
            return res.status(500).json({ error: err.message || "Database error" });
        }
        res.json(results);
    });
});

// ---------------------------
// Orders
// ---------------------------
app.get('/api/orders/:phone', (req, res) => {
    const phone = req.params.phone;
    
    db.query(
        'SELECT * FROM orders WHERE phone = ? ORDER BY order_date DESC LIMIT 10',
        [phone],
        (err, results) => {
            if (err) return res.status(500).json({ error: "Database error" });
            res.json(results);
        }
    );
});

app.get('/api/orders-summary/:phone', (req, res) => {
    const phone = req.params.phone;
    
    db.query(
        'SELECT COUNT(*) as total_orders, SUM(total_amount) as total_spent FROM orders WHERE phone = ?',
        [phone],
        (err, results) => {
            if (err) return res.status(500).json({ error: "Database error" });
            res.json(results[0]);
        }
    );
});

// Get all orders (for Orders page)
app.get('/api/orders', (req, res) => {
    db.query(
        'SELECT id, order_id, customer_name, phone, product, amount, COALESCE(total_amount, amount) AS total_amount, status, order_date FROM orders ORDER BY order_date DESC',
        (err, results) => {
            if (err) {
                console.error('Error fetching orders:', err);
                return res.status(500).json({ error: "Database error" });
            }
            // Format results for frontend
            const formattedResults = results.map(order => ({
                id: order.order_id,
                customerName: order.customer_name,
                product: order.product,
                amount: parseFloat(order.total_amount) || 0,
                status: order.status,
                date: new Date(order.order_date).toLocaleDateString()
            }));
            res.json(formattedResults);
        }
    );
});

// Create new order
app.post('/api/orders', (req, res) => {
    const { items, total, table, server } = req.body;
    
    if (!items || !total) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    // Generate order ID
    const orderId = `ORD-${Date.now()}`;
    
    // Format items for storage
    const productList = items.map(item => `${item.name} x${item.quantity}`).join(', ');
    
    const insertSql = isPg
        ? 'INSERT INTO orders (order_id, customer_name, phone, product, amount, total_amount, status) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
        : 'INSERT INTO orders (order_id, customer_name, phone, product, amount, total_amount, status) VALUES (?, ?, ?, ?, ?, ?, ?)';
    db.query(
        insertSql,
        [orderId, `Table ${table || 'Unknown'}`, server || 'POS', productList, total, total, 'confirmed'],
        (err, result) => {
            if (err) {
                console.error('Error creating order:', err);
                return res.status(500).json({ error: "Database error" });
            }

            const responsePayload = { success: true, orderId, id: result.insertId };

            startDeliverySimulationForOrder(orderId, (deliveryErr) => {
                if (deliveryErr) {
                    console.error('Failed to auto-start delivery for order:', orderId, deliveryErr);
                }
                res.json(responsePayload);
            });
        }
    );
});

// Update order status
app.put('/api/orders/:orderId', isAuthenticated, (req, res) => {
    const { orderId } = req.params;
    const { status } = req.body;
    
    if (!status) {
        return res.status(400).json({ error: "Status is required" });
    }

    db.query(
        'UPDATE orders SET status = ? WHERE order_id = ?',
        [status, orderId],
        (err, result) => {
            if (err) {
                console.error('Error updating order:', err);
                return res.status(500).json({ error: "Database error" });
            }
            res.json({ success: true, message: "Order updated" });
        }
    );
});

// Debug endpoint - see all orders in database
app.get('/api/debug/all-orders', (req, res) => {
    db.query('SELECT * FROM orders ORDER BY order_date DESC LIMIT 20', (err, results) => {
        if (err) return res.status(500).json({ error: "Database error" });
        res.json(results);
    });
});

// ---------------------------
// Delivery Tracking System
// ---------------------------

// Get tracking info for an order
app.get('/api/tracking/:orderId', (req, res) => {
    const orderId = req.params.orderId;
    
    db.query(
        `SELECT o.id as order_id_num, o.order_id, o.customer_name, o.phone, o.product, o.items, o.amount, o.total_amount, o.status, o.order_date, o.created_at, o.updated_at, o.conversation_id,
         d.id as delivery_id, d.rider_name, d.vehicle, d.current_lat, d.current_lng, d.customer_lat, d.customer_lng, d.delivery_status, 
         d.order_confirmed_time, d.rider_assigned_time, d.picked_up_time, d.in_transit_time, d.arriving_time, d.delivered_time
         FROM orders o 
         LEFT JOIN deliveries d ON o.id = d.order_id 
         WHERE o.order_id = ?`,
        [orderId],
        (err, results) => {
            if (err) {
                return res.status(500).json({ error: "Database error" });
            }
            
            if (!results || results.length === 0) {
                return res.status(404).json({ error: "Order not found" });
            }
            
            const order = results[0];
            res.json({
                id: order.order_id_num,
                order_id: order.order_id,
                customer_name: order.customer_name,
                phone: order.phone,
                product: order.product,
                items: order.items,
                total_amount: order.total_amount,
                status: order.status,
                order_date: order.order_date,
                delivery: order.delivery_status ? {
                    id: order.delivery_id,
                    status: order.delivery_status || 'pending',
                    rider_name: order.rider_name || 'Assigned Rider',
                    vehicle: order.vehicle || 'Motorcycle',
                    current_lat: order.current_lat,
                    current_lng: order.current_lng,
                    customer_lat: order.customer_lat,
                    customer_lng: order.customer_lng,
                    order_confirmed_time: order.order_confirmed_time,
                    rider_assigned_time: order.rider_assigned_time,
                    picked_up_time: order.picked_up_time,
                    in_transit_time: order.in_transit_time,
                    arriving_time: order.arriving_time,
                    delivered_time: order.delivered_time
                } : null
            });
        }
    );
});

// Get all active deliveries
app.get('/api/deliveries/active', (req, res) => {
    db.query(
        `SELECT d.id, d.order_id, o.order_id as order_code, d.rider_name, d.vehicle, d.current_lat, d.current_lng, d.customer_lat, d.customer_lng, d.delivery_status 
         FROM deliveries d 
         LEFT JOIN orders o ON d.order_id = o.id 
         WHERE d.delivery_status != 'delivered' AND d.delivery_status != 'cancelled'
         ORDER BY d.updated_at DESC`,
        (err, results) => {
            if (err) {
                return res.status(500).json({ error: "Database error" });
            }
            
            const deliveries = (results || []).map(d => ({
                id: d.id,
                order_id: d.order_code,
                rider_name: d.rider_name,
                vehicle: d.vehicle,
                current_lat: parseFloat(d.current_lat),
                current_lng: parseFloat(d.current_lng),
                customer_lat: parseFloat(d.customer_lat),
                customer_lng: parseFloat(d.customer_lng),
                delivery_status: d.delivery_status || 'pending'
            }));
            
            res.json(deliveries);
        }
    );
});

const deliveryTimers = new Map();

function clearDeliveryTimers(deliveryId) {
    const timers = deliveryTimers.get(deliveryId);
    if (timers) {
        timers.forEach((timer) => clearTimeout(timer));
        deliveryTimers.delete(deliveryId);
    }
}

function broadcastDeliveryUpdate(orderId, callback) {
    db.query(`SELECT o.*, d.* FROM orders o LEFT JOIN deliveries d ON o.id = d.order_id WHERE o.order_id = ?`, [orderId], (err, results) => {
        if (err) return callback(err);
        if (!results || results.length === 0) return callback(new Error('Order not found'));
        const order = results[0];
        const responseData = {
            id: order.id,
            order_id: order.order_id,
            customer_name: order.customer_name,
            total_amount: order.total_amount,
            items: order.items,
            delivery: order.delivery_status ? {
                status: order.delivery_status,
                rider_name: order.rider_name,
                vehicle: order.vehicle,
                current_lat: order.current_lat,
                current_lng: order.current_lng,
                customer_lat: order.customer_lat,
                customer_lng: order.customer_lng,
                order_confirmed_time: order.order_confirmed_time,
                rider_assigned_time: order.rider_assigned_time,
                picked_up_time: order.picked_up_time,
                in_transit_time: order.in_transit_time,
                arriving_time: order.arriving_time,
                delivered_time: order.delivered_time
            } : null
        };
        io.emit('delivery-update', responseData);
        callback(null, responseData);
    });
}

function updateDeliveryStatus(deliveryId, orderDbId, orderId, newStatus, timeField, callback) {
    const queries = [];
    const params = [];

    if (timeField) {
        queries.push(`${timeField} = NOW()`);
    }
    queries.push(`delivery_status = ?`);
    params.push(newStatus, deliveryId);

    const sql = `UPDATE deliveries SET ${queries.join(', ')} WHERE id = ?`;
    db.query(sql, params, (err) => {
        if (err) return callback(err);
        db.query(`UPDATE orders SET status = ? WHERE id = ?`, [newStatus, orderDbId], (err) => {
            if (err) console.error('Failed to update order status:', err);
            broadcastDeliveryUpdate(orderId, () => callback(null));
        });
    });
}

function moveRiderTowardsCustomer(deliveryId, orderId, intervalRef) {
    db.query('SELECT * FROM deliveries WHERE id = ?', [deliveryId], (err, results) => {
        if (err || !results || results.length === 0) {
            clearInterval(intervalRef);
            return;
        }

        const delivery = results[0];
        const currentLat = parseFloat(delivery.current_lat);
        const currentLng = parseFloat(delivery.current_lng);
        const customerLat = parseFloat(delivery.customer_lat);
        const customerLng = parseFloat(delivery.customer_lng);
        const distance = Math.sqrt(Math.pow(customerLat - currentLat, 2) + Math.pow(customerLng - currentLng, 2));
        const step = 0.0004;

        if (distance <= step) {
            db.query(`UPDATE deliveries SET current_lat = ?, current_lng = ? WHERE id = ?`, [customerLat, customerLng, deliveryId], (err) => {
                if (err) console.error('Failed to update rider location:', err);
                broadcastDeliveryUpdate(orderId, () => {});
            });
            clearInterval(intervalRef);
            return;
        }

        const newLat = currentLat + ((customerLat - currentLat) * (step / distance));
        const newLng = currentLng + ((customerLng - currentLng) * (step / distance));
        db.query(`UPDATE deliveries SET current_lat = ?, current_lng = ? WHERE id = ?`, [newLat, newLng, deliveryId], (err) => {
            if (err) {
                console.error('Failed to update rider location:', err);
                return;
            }
            broadcastDeliveryUpdate(orderId, () => {});
        });
    });
}

function scheduleDeliveryLifecycle(deliveryId, orderId, orderDbId, customerLat, customerLng) {
    clearDeliveryTimers(deliveryId);
    const timers = [];
    deliveryTimers.set(deliveryId, timers);

    const assignDelay = 20 + Math.floor(Math.random() * 15); // 20-35 seconds
    const pickupDelay = assignDelay + 90 + Math.floor(Math.random() * 45); // 1.5-2.25 min after assign
    const transitDelay = pickupDelay + 35 + Math.floor(Math.random() * 25); // 35-60 sec after pickup
    const arrivingDelay = transitDelay + 180 + Math.floor(Math.random() * 80); // 3-4.5 min after in transit
    const deliveredDelay = arrivingDelay + 80 + Math.floor(Math.random() * 40); // 1.5-2.5 min after arriving

    // Rider assigned
    timers.push(setTimeout(() => {
        updateDeliveryStatus(deliveryId, orderDbId, orderId, 'rider_assigned', 'rider_assigned_time', () => {});
    }, assignDelay * 1000));

    // Food picked up after rider assignment
    timers.push(setTimeout(() => {
        updateDeliveryStatus(deliveryId, orderDbId, orderId, 'picked_up', 'picked_up_time', () => {});
    }, pickupDelay * 1000));

    // In transit after pickup
    timers.push(setTimeout(() => {
        updateDeliveryStatus(deliveryId, orderDbId, orderId, 'in_transit', 'in_transit_time', () => {
            const movementInterval = setInterval(() => moveRiderTowardsCustomer(deliveryId, orderId, movementInterval), 2500);
            timers.push(movementInterval);
        });
    }, transitDelay * 1000));

    // Arriving soon
    timers.push(setTimeout(() => {
        updateDeliveryStatus(deliveryId, orderDbId, orderId, 'arriving', 'arriving_time', () => {});
    }, arrivingDelay * 1000));

    // Delivered
    timers.push(setTimeout(() => {
        updateDeliveryStatus(deliveryId, orderDbId, orderId, 'delivered', 'delivered_time', () => {
            clearDeliveryTimers(deliveryId);
        });
    }, deliveredDelay * 1000));
}

function startDeliverySimulationForOrder(orderId, callback) {
    db.query('SELECT * FROM orders WHERE order_id = ?', [orderId], (err, results) => {
        if (err || !results || results.length === 0) {
            return callback(err || new Error('Order not found'));
        }

        const order = results[0];
        const restaurantLat = 9.0765;
        const restaurantLng = 7.3986;
        const customerLat = 9.0865 + (Math.random() - 0.5) * 0.1;
        const customerLng = 7.4086 + (Math.random() - 0.5) * 0.1;

        const riders = [
            { name: 'Chioma Adeyemi', vehicle: 'Motorcycle' },
            { name: 'Tunde Okafor', vehicle: 'Motorcycle' },
            { name: 'Zainab Hassan', vehicle: 'Motorcycle' }
        ];
        const rider = riders[Math.floor(Math.random() * riders.length)];

        const insertSql = isPg
            ? `INSERT INTO deliveries (order_id, rider_name, vehicle, current_lat, current_lng, customer_lat, customer_lng, delivery_status, order_confirmed_time) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW()) RETURNING id`
            : `INSERT INTO deliveries (order_id, rider_name, vehicle, current_lat, current_lng, customer_lat, customer_lng, delivery_status, order_confirmed_time) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`;
        db.query(
            insertSql,
            [order.id, rider.name, rider.vehicle, restaurantLat, restaurantLng, customerLat, customerLng, 'order_confirmed'],
            (err, result) => {
                if (err) {
                    console.error('Delivery start error:', err);
                    return callback(err);
                }
                const deliveryId = result.insertId;
                scheduleDeliveryLifecycle(deliveryId, orderId, order.id, customerLat, customerLng);
                callback(null, rider);
            }
        );
    });
}

// Start delivery simulation for an order
app.post('/api/delivery/start', (req, res) => {
    const orderId = req.body.order_id;

    startDeliverySimulationForOrder(orderId, (err, rider) => {
        if (err) {
            if (err.message === 'Order not found') {
                return res.status(404).json({ error: 'Order not found' });
            }
            return res.status(500).json({ error: 'Database error' });
        }

        res.json({ success: true, message: 'Delivery started', rider });
    });
});

// Update rider location during delivery
app.post('/api/delivery/update-location', (req, res) => {
    const orderId = req.body.order_id;
    
    db.query('SELECT * FROM deliveries WHERE order_id = (SELECT id FROM orders WHERE order_id = ?)', [orderId], (err, results) => {
        if (err || !results || results.length === 0) {
            return res.status(404).json({ error: "Delivery not found" });
        }
        
        const delivery = results[0];
        const currentLat = parseFloat(delivery.current_lat);
        const currentLng = parseFloat(delivery.current_lng);
        const customerLat = parseFloat(delivery.customer_lat);
        const customerLng = parseFloat(delivery.customer_lng);
        
        // Move rider toward customer location
        const distance = Math.sqrt(Math.pow(customerLat - currentLat, 2) + Math.pow(customerLng - currentLng, 2));
        const step = Math.max(0.0003, Math.min(0.0015, distance * 0.18));

        let newLat = currentLat;
        let newLng = currentLng;
        let newStatus = delivery.delivery_status;
        let updateFields = [];

        if (delivery.delivery_status === 'picked_up' || delivery.delivery_status === 'in_transit' || delivery.delivery_status === 'arriving') {
            if (distance > step) {
                newLat = currentLat + (customerLat - currentLat) * (step / distance);
                newLng = currentLng + (customerLng - currentLng) * (step / distance);

                if (delivery.delivery_status === 'picked_up') {
                    newStatus = 'in_transit';
                    updateFields.push(`in_transit_time = NOW()`);
                } else if (delivery.delivery_status === 'in_transit' && distance < 1.2) {
                    newStatus = 'arriving';
                    if (delivery.delivery_status !== 'arriving') {
                        updateFields.push(`arriving_time = NOW()`);
                    }
                } else {
                    newStatus = delivery.delivery_status;
                }
            } else {
                newLat = customerLat;
                newLng = customerLng;
                newStatus = 'delivered';
                if (delivery.delivery_status !== 'delivered') {
                    updateFields.push(`arriving_time = NOW()`);
                    updateFields.push(`delivered_time = NOW()`);
                }
            }
        } else {
            // Rider waiting for assignment or pickup
            newStatus = delivery.delivery_status;
        }

        // Update only if changed
        if (newStatus !== delivery.delivery_status && !updateFields.includes(`${newStatus}_time = NOW()`)) {
            if (newStatus === 'in_transit' && delivery.delivery_status !== 'in_transit') {
                updateFields.push(`in_transit_time = NOW()`);
            } else if (newStatus === 'arriving' && delivery.delivery_status !== 'arriving') {
                updateFields.push(`arriving_time = NOW()`);
            }
        }
        
        const fieldsStr = updateFields.length > 0 ? ', ' + updateFields.join(', ') : '';
        
        db.query(
            `UPDATE deliveries SET current_lat = ?, current_lng = ?, delivery_status = ? ${fieldsStr} 
             WHERE id = ?`,
            [newLat, newLng, newStatus, delivery.id],
            (err) => {
                if (err) {
                    console.error('Location update error:', err);
                    return res.status(500).json({ error: "Database error" });
                }
                
                // Fetch updated delivery
                db.query(`SELECT o.*, d.* FROM orders o LEFT JOIN deliveries d ON o.id = d.order_id WHERE o.order_id = ?`, [orderId], (err, updated) => {
                    if (err) return res.status(500).json({ error: "Database error" });
                    
                    const order = updated[0];
                    const responseData = {
                        id: order.id,
                        order_id: order.order_id,
                        customer_name: order.customer_name,
                        total_amount: order.total_amount,
                        items: order.items,
                        delivery: {
                            status: order.delivery_status,
                            rider_name: order.rider_name,
                            current_lat: order.current_lat,
                            current_lng: order.current_lng,
                            customer_lat: order.customer_lat,
                            customer_lng: order.customer_lng
                        }
                    };
                    
                    // Broadcast update via Socket.io
                    io.emit('delivery-update', responseData);
                    res.json(responseData);
                });
            }
        );
    });
});

// Complete delivery
app.post('/api/delivery/complete', (req, res) => {
    const orderId = req.body.order_id;
    
    db.query('SELECT id FROM orders WHERE order_id = ?', [orderId], (err, results) => {
        if (err || !results || results.length === 0) {
            return res.status(404).json({ error: "Order not found" });
        }
        
        const orderId_db = results[0].id;
        
        db.query(
            `UPDATE deliveries SET delivery_status = ?, delivered_time = NOW() WHERE order_id = ?`,
            ['delivered', orderId_db],
            (err) => {
                if (err) {
                    return res.status(500).json({ error: "Database error" });
                }
                
                // Also update order status
                db.query(`UPDATE orders SET status = ? WHERE id = ?`, ['delivered', orderId_db], (err) => {
                    if (err) console.error('Order status update error:', err);
                });
                
                res.json({ success: true, message: "Delivery completed" });
            }
        );
    });
});

// ---------------------------
// Settings
// ---------------------------
app.get('/api/settings', (req, res) => {
    const userId = req.session.userId;
    db.query('SELECT * FROM settings WHERE user_id = ?', [userId], (err, result) => {
        if (err) return res.json({});
        res.json(result[0] || {});
    });
});

app.post('/api/settings', (req, res) => {
    const userId = req.session.userId;
    const data = req.body;
    const query = `
        INSERT INTO settings 
        (user_id, displayName, email, autoReply, chatEnabled, msgAlert, ticketAlert, soundAlert, autopilotMode, priority, autoAssign)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          displayName = VALUES(displayName),
          email = VALUES(email),
          autoReply = VALUES(autoReply),
          chatEnabled = VALUES(chatEnabled),
          msgAlert = VALUES(msgAlert),
          ticketAlert = VALUES(ticketAlert),
          soundAlert = VALUES(soundAlert),
          autopilotMode = VALUES(autopilotMode),
          priority = VALUES(priority),
          autoAssign = VALUES(autoAssign)
    `;
    db.query(query, [
        userId,
        data.displayName,
        data.email,
        data.autoReply,
        data.chatEnabled,
        data.msgAlert,
        data.ticketAlert,
        data.soundAlert,
        data.autopilotMode,
        data.priority,
        data.autoAssign
    ], (err) => {
        if (err) return res.sendStatus(500);
        res.sendStatus(200);
    });
});

// Upload avatar image for current user
app.post('/api/settings/avatar', isAuthenticated, upload.single('avatar'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'no_file' });
        const url = `/uploads/${req.file.filename}`;
        const userId = req.session.userId;
        // store avatar metadata in user_avatars table
        const insertSql = isPg
            ? 'INSERT INTO user_avatars (user_id, filename, url) VALUES (?, ?, ?) RETURNING id'
            : 'INSERT INTO user_avatars (user_id, filename, url) VALUES (?, ?, ?)';
        db.query(insertSql, [userId, req.file.filename, url], (err, result) => {
            if (err) {
                console.error('Error inserting into user_avatars', err);
                return res.status(500).json({ error: 'db_error' });
            }
            const avatarId = result.insertId;
            // update settings.avatar_url for quick lookup
            const avatarSql = isPg
                ? 'INSERT INTO settings (user_id, avatar_url) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET avatar_url = EXCLUDED.avatar_url'
                : 'INSERT INTO settings (user_id, avatar_url) VALUES (?, ?) ON DUPLICATE KEY UPDATE avatar_url = VALUES(avatar_url)';
            db.query(avatarSql, [userId, url], (err2) => {
                if (err2) {
                    console.error('Error saving avatar url to settings', err2);
                    // still return success for the upload but include warning
                    return res.status(200).json({ success: true, url, avatarId, warning: 'failed_to_update_settings' });
                }
                res.json({ success: true, url, avatarId });
            });
        });
    } catch (e) {
        console.error('avatar upload error', e);
        res.status(500).json({ error: 'internal' });
    }
});

// ---------------------------
// Create HTTP server & Socket.IO
// ---------------------------
const httpServer = http.createServer(app);
const io = new Server(httpServer);

io.on("connection", (socket) => {
    console.log("New client connected:", socket.id);

    // Agent registers after connecting with their user info
    socket.on("agent:register", (agent) => {
        // agent: { userId, name, role }
        try {
            const role = agent && agent.role ? String(agent.role).toLowerCase() : null;
            // Do NOT register viewers as agents (they are read-only)
            if (role === 'viewer') {
                console.log("Viewer connected via socket, not registering as agent:", socket.id);
                return;
            }
        } catch (e) {}

        const record = Object.assign({}, agent, { socketId: socket.id, lastActive: Date.now(), activeConversation: null });
        onlineAgents.set(socket.id, record);
        // Broadcast presence list to all clients
        const list = Array.from(onlineAgents.values()).map(a => ({ userId: a.userId, name: a.name, role: a.role, activeConversation: a.activeConversation }));
        io.emit("presenceUpdate", list);
        console.log("Agent registered for presence:", record);
    });

    // Agent notifies which conversation they're viewing/active on
    socket.on("agent:activeConversation", (data) => {
        const rec = onlineAgents.get(socket.id);
        if (rec) {
            rec.activeConversation = data && data.conversationId ? data.conversationId : null;
            rec.lastActive = Date.now();
            onlineAgents.set(socket.id, rec);
        }
        const list = Array.from(onlineAgents.values()).map(a => ({ userId: a.userId, name: a.name, role: a.role, activeConversation: a.activeConversation }));
        io.emit("presenceUpdate", list);
    });

    // Typing indicators
    socket.on("typing", (data) => {
        // data: { conversationId, userId, name }
        if (!data || !data.conversationId) return;
        socket.broadcast.emit("typing", data);
    });

    socket.on("stopTyping", (data) => {
        if (!data || !data.conversationId) return;
        socket.broadcast.emit("stopTyping", data);
    });

    socket.on("disconnect", () => {
        onlineAgents.delete(socket.id);
        const list = Array.from(onlineAgents.values()).map(a => ({ userId: a.userId, name: a.name, role: a.role, activeConversation: a.activeConversation }));
        io.emit("presenceUpdate", list);
        console.log("Client disconnected:", socket.id);
    });
});

// Debug route: emit a newMessage event (useful for testing the UI/websocket)
// POST JSON: { conversation_id: 123, sender: 'instagram', message: 'hello' }
// GET query: /debug/emit-new-message?conversation_id=123&message=hello
app.all('/debug/emit-new-message', (req, res) => {
    const data = Object.assign({}, req.method === 'GET' ? req.query : req.body || {});
    const conversation_id = data.conversation_id || data.conversationId || data.id;
    if (!conversation_id) return res.status(400).json({ error: 'conversation_id required' });
    const payload = {
        conversation_id: conversation_id,
        sender: data.sender || 'instagram',
        message: data.message || data.msg || 'Debug message',
        created_at: new Date().toISOString()
    };
    try {
        io.emit('newMessage', payload);
        console.log('Debug emit newMessage', payload);
        res.json({ ok: true, emitted: payload });
    } catch (err) {
        console.error('Debug emit failed', err);
        res.status(500).json({ error: 'emit failed', details: String(err) });
    }
});

// Find the best available staff member for a conversation based on skills and workload
function findBestStaffForConversation(conversationId, callback) {
    // Get conversation details to determine required skills
    db.query(`
        SELECT c.phone, m.message, m.created_at
        FROM conversations c
        LEFT JOIN messages m ON c.id = m.conversation_id AND m.sender = 'received'
        WHERE c.id = ?
        ORDER BY m.created_at DESC
        LIMIT 5
    `, [conversationId], (err, messages) => {
        if (err) {
            console.log('Error fetching conversation for staff assignment:', err);
            return callback(null); // No assignment
        }

        // Analyze conversation for required skills
        const conversationText = messages.map(m => m.message || '').join(' ').toLowerCase();
        let requiredSkills = [];

        if (conversationText.includes('refund') || conversationText.includes('cancel') || conversationText.includes('money')) {
            requiredSkills.push('refunds');
        }
        if (conversationText.includes('order') || conversationText.includes('delivery') || conversationText.includes('food')) {
            requiredSkills.push('orders');
        }
        if (conversationText.includes('technical') || conversationText.includes('bug') || conversationText.includes('error')) {
            requiredSkills.push('technical');
        }
        if (conversationText.includes('complain') || conversationText.includes('angry') || conversationText.includes('escalate')) {
            requiredSkills.push('escalations', 'complaints');
        }

        // Default to general if no specific skills identified
        if (requiredSkills.length === 0) {
            requiredSkills = ['general'];
        }

        // Find available staff with matching skills
        const onlineStaffIds = Array.from(onlineAgents.keys()).filter(socketId => {
            const agent = onlineAgents.get(socketId);
            return agent && agent.role === 'agent' && agent.activeConversation === null;
        }).map(socketId => onlineAgents.get(socketId).userId);

        if (onlineStaffIds.length === 0) {
            console.log('No online staff available for assignment');
            return callback(null);
        }

        // Query staff with skills
        const placeholders = onlineStaffIds.map(() => '?').join(',');
        db.query(`SELECT id, name, skills FROM users WHERE id IN (${placeholders}) AND role = 'agent'`, onlineStaffIds, (err, staff) => {
            if (err) {
                console.log('Error fetching staff skills:', err);
                return callback(null);
            }

            // Score staff based on skill match and current workload
            let bestStaff = null;
            let bestScore = -1;

            staff.forEach(agent => {
                if (!agent.skills) return;

                const agentSkills = agent.skills.split(',').map(s => s.trim().toLowerCase());
                let skillMatch = 0;

                requiredSkills.forEach(reqSkill => {
                    if (agentSkills.includes(reqSkill.toLowerCase())) {
                        skillMatch++;
                    }
                });

                // Calculate score: skill match + availability bonus
                const score = skillMatch * 10; // Prioritize skill match

                if (score > bestScore) {
                    bestScore = score;
                    bestStaff = agent.id;
                }
            });

            console.log(`Assigned conversation ${conversationId} to staff ${bestStaff} (skills: ${requiredSkills.join(',')})`);
            callback(bestStaff);
        });
    });
}

setHandoffCallback((conversationId) => {
    disableAIForConversation(conversationId);
    // Insert or update escalations table and emit an escalation event with details
    db.query("SELECT c.phone, c.id FROM conversations c WHERE c.id = ?", [conversationId], (err, results) => {
        const phone = (results && results[0] && results[0].phone) ? results[0].phone : null;
        const customerName = phone || 'Unknown';

        // Find best available staff for this conversation
        findBestStaffForConversation(conversationId, (assignedStaffId) => {
            const upsertSql = isPg
                ? `INSERT INTO escalations (conversation_id, customer_name, alarm_active, assigned_staff_id) VALUES (?, ?, TRUE, ?) ON CONFLICT (conversation_id) DO UPDATE SET escalated_at = CURRENT_TIMESTAMP, alarm_active = TRUE, snoozed_until = NULL, claimed_by = NULL, claim_time = NULL, assigned_staff_id = ?`
                : `INSERT INTO escalations (conversation_id, customer_name, alarm_active, assigned_staff_id) VALUES (?, ?, 1, ?) ON DUPLICATE KEY UPDATE escalated_at = CURRENT_TIMESTAMP, alarm_active = 1, snoozed_until = NULL, claimed_by = NULL, claim_time = NULL, assigned_staff_id = ?`;
            db.query(upsertSql, [conversationId, customerName, assignedStaffId, assignedStaffId], (uErr) => {
                if (uErr) console.log('Escalation upsert error:', uErr);
                io.emit("escalationRaised", { conversationId, customerName, assignedStaffId });
                // Notify specifically assigned staff (if online)
                if (assignedStaffId) {
                    let assignedSocketId = null;
                    for (const [sockId, rec] of onlineAgents.entries()) {
                        if (rec && rec.userId === assignedStaffId) {
                            assignedSocketId = sockId;
                            break;
                        }
                    }
                    if (assignedSocketId) {
                                io.to(assignedSocketId).emit('escalationAssigned', { conversationId, customerName, assignedStaffId });
                    } else {
                        // Assigned staff not currently connected -- broadcast to all online agents as a fallback
                        console.log(`Assigned staff ${assignedStaffId} not connected; broadcasting escalationAssigned to all agents for conversation ${conversationId}`);
                        for (const [sockId, rec] of onlineAgents.entries()) {
                            if (rec && rec.role === 'agent') {
                                        io.to(sockId).emit('escalationAssigned', { conversationId, customerName, assignedStaffId });
                            }
                        }
                    }
                }
                // legacy event for other clients
                io.emit("handoffAlert", { conversationId });
            });
        });
    });
});

// Add endpoint to fetch analytics data
app.get('/api/analytics', isAuthenticated, async (req, res) => {
    try {
        // Number of chats
        const [chats] = await db.promise().query('SELECT COUNT(*) AS count FROM conversations');
        // Number of tickets
        const [tickets] = await db.promise().query('SELECT COUNT(*) AS count FROM tickets');
        // Number of escalated tickets
        const [escalatedTickets] = await db.promise().query('SELECT COUNT(*) AS count FROM tickets WHERE escalated = 1');
        // Number of receipts
        const [receipts] = await db.promise().query('SELECT COUNT(*) AS count FROM receipts');
        // Number of escalated receipts
        const [escalatedReceipts] = await db.promise().query('SELECT COUNT(*) AS count FROM receipts WHERE escalated = 1');
        // Number of escalated chats
        const [escalatedChats] = await db.promise().query('SELECT COUNT(*) AS count FROM escalations');
        // Number of resolved chats
        const [resolvedChats] = await db.promise().query('SELECT COUNT(*) AS count FROM resolved');

        // AI feedback aggregates
        const [fbCountRow] = await db.promise().query('SELECT COUNT(*) AS count FROM ai_feedback');
        const [fbAvgRow] = await db.promise().query('SELECT AVG(rating) AS avg_rating FROM ai_feedback WHERE rating IS NOT NULL');
        const [fbPositiveRow] = await db.promise().query('SELECT SUM(CASE WHEN rating >= 4 THEN 1 ELSE 0 END) AS positive FROM ai_feedback WHERE rating IS NOT NULL');
        const aiFeedbackCount = (fbCountRow && fbCountRow[0] && fbCountRow[0].count) ? Number(fbCountRow[0].count) : 0;
        const aiFeedbackAvg = (fbAvgRow && fbAvgRow[0] && fbAvgRow[0].avg_rating) ? Number(fbAvgRow[0].avg_rating) : null;
        const aiFeedbackPositive = (fbPositiveRow && fbPositiveRow[0] && fbPositiveRow[0].positive) ? Number(fbPositiveRow[0].positive) : 0;

        res.json({
            numChats: chats[0].count,
            numTickets: tickets[0].count,
            numEscalatedTickets: escalatedTickets[0].count,
            numReceipts: receipts[0].count,
            numEscalatedReceipts: escalatedReceipts[0].count,
            numEscalatedChats: escalatedChats[0].count,
            numResolvedChats: resolvedChats[0].count,
            aiFeedbackCount,
            aiFeedbackAvg,
            aiFeedbackPositive
        });
    } catch (error) {
        console.error('Error fetching analytics data:', error);
        res.status(500).json({ error: 'Failed to fetch analytics data' });
    }
});

// API endpoint for ticket counts by time period
app.get('/api/tickets-by-period', async (req, res) => {
    try {
        const ticketCountsSql = isPg
            ? `SELECT
                SUM((created_at::date = CURRENT_DATE)::int) AS daily,
                SUM((DATE_TRUNC('week', created_at) = DATE_TRUNC('week', CURRENT_DATE))::int) AS weekly,
                SUM((DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE))::int) AS monthly
            FROM tickets`
            : `SELECT
                SUM(DATE(created_at) = CURDATE()) AS daily,
                SUM(YEARWEEK(created_at, 1) = YEARWEEK(CURDATE(), 1)) AS weekly,
                SUM(YEAR(created_at) = YEAR(CURDATE()) AND MONTH(created_at) = MONTH(CURDATE())) AS monthly
            FROM tickets`;
        const [rows] = await db.promise().query(ticketCountsSql);

        const counts = rows[0] || { daily: 0, weekly: 0, monthly: 0 };
        console.log('tickets-by-period counts', counts);

        res.json({
            daily: Number(counts.daily) || 0,
            weekly: Number(counts.weekly) || 0,
            monthly: Number(counts.monthly) || 0
        });
    } catch (error) {
        console.error('Error fetching tickets by period:', error);
        res.status(500).json({ error: 'Failed to fetch tickets by period' });
    }
});

// API endpoint for message counts by time period (received messages only)
app.get('/api/messages-by-period', isAuthenticated, async (req, res) => {
    try {
        const [dailyMessages] = await db.promise().query(isPg
            ? `SELECT COUNT(*) AS count FROM messages WHERE sender <> 'sent' AND created_at::date = CURRENT_DATE`
            : `SELECT COUNT(*) AS count FROM messages WHERE sender <> 'sent' AND DATE(created_at) = CURDATE()`
        );

        const [weeklyMessages] = await db.promise().query(isPg
            ? `SELECT COUNT(*) AS count FROM messages WHERE sender <> 'sent' AND DATE_TRUNC('week', created_at) = DATE_TRUNC('week', CURRENT_DATE)`
            : `SELECT COUNT(*) AS count FROM messages WHERE sender <> 'sent' AND YEARWEEK(created_at, 1) = YEARWEEK(CURDATE(), 1)`
        );

        const [monthlyMessages] = await db.promise().query(isPg
            ? `SELECT COUNT(*) AS count FROM messages WHERE sender <> 'sent' AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE)`
            : `SELECT COUNT(*) AS count FROM messages WHERE sender <> 'sent' AND YEAR(created_at) = YEAR(CURDATE()) AND MONTH(created_at) = MONTH(CURDATE())`
        );

        const [totalMessages] = await db.promise().query(`
            SELECT COUNT(*) AS count FROM messages
            WHERE sender <> 'sent'
        `);

        console.log('Messages counts:', {
            daily: dailyMessages[0].count,
            weekly: weeklyMessages[0].count,
            monthly: monthlyMessages[0].count,
            total: totalMessages[0].count
        });

        res.json({
            daily: dailyMessages[0].count,
            weekly: weeklyMessages[0].count,
            monthly: monthlyMessages[0].count
        });
    } catch (error) {
        console.error('Error fetching messages by period:', error);
        res.status(500).json({ error: 'Failed to fetch messages by period' });
    }
});

// ---------------------------
// Start server
// ---------------------------
const PORT = process.env.PORT || 3000;
// Ensure `deliveries` table exists for delivery simulation
if (isPg) {
    db.query(`
        CREATE TABLE IF NOT EXISTS deliveries (
            id INT AUTO_INCREMENT PRIMARY KEY,
            order_id INT NOT NULL,
            rider_name VARCHAR(255),
            vehicle VARCHAR(128),
            current_lat DOUBLE PRECISION,
            current_lng DOUBLE PRECISION,
            customer_lat DOUBLE PRECISION,
            customer_lng DOUBLE PRECISION,
            delivery_status VARCHAR(64) DEFAULT 'pending',
            order_confirmed_time TIMESTAMP,
            rider_assigned_time TIMESTAMP,
            picked_up_time TIMESTAMP,
            in_transit_time TIMESTAMP,
            arriving_time TIMESTAMP,
            delivered_time TIMESTAMP,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW(),
            FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
        );
    `, (err) => {
        if (err) console.error('Could not create deliveries table (pg):', err);
        else {
            db.query('CREATE INDEX IF NOT EXISTS idx_deliveries_order_id ON deliveries(order_id)', (ie) => {});
            console.log('Deliveries table ready (pg)');
        }
    });
} else {
    db.query(`
        CREATE TABLE IF NOT EXISTS deliveries (
            id INT AUTO_INCREMENT PRIMARY KEY,
            order_id INT NOT NULL,
            rider_name VARCHAR(255),
            vehicle VARCHAR(128),
            current_lat DOUBLE,
            current_lng DOUBLE,
            customer_lat DOUBLE,
            customer_lng DOUBLE,
            delivery_status VARCHAR(64) DEFAULT 'pending',
            order_confirmed_time DATETIME,
            rider_assigned_time DATETIME,
            picked_up_time DATETIME,
            in_transit_time DATETIME,
            arriving_time DATETIME,
            delivered_time DATETIME,
            created_at DATETIME DEFAULT NOW(),
            updated_at DATETIME DEFAULT NOW() ON UPDATE NOW(),
            INDEX (order_id),
            FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `, (err) => {
        if (err) {
            console.error('Could not create deliveries table:', err);
        } else {
            console.log('Deliveries table ready');
        }
    });
}
httpServer.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Stop the process using it or set a different PORT environment variable.`);
        process.exit(1);
    }
    console.error('HTTP server error:', err);
    process.exit(1);
});

httpServer.listen(PORT, () => {
        // Print non-sensitive DB info for debugging (do NOT log passwords)
        try {
            const dbHost = (dbConfig && dbConfig.host) || process.env.DB_HOST || 'unknown';
            const dbPort = (dbConfig && dbConfig.port) || process.env.DB_PORT || 'unknown';
            const dbName = (dbConfig && dbConfig.database) || process.env.DB_NAME || 'unknown';
            console.log(`✅🎲Server running on port ${PORT}🎲`);
            console.log(`DB host: ${dbHost}, port: ${dbPort}, database: ${dbName}`);
        if (connectDatabase) {
            connectDatabase((err) => {
                if (err) {
                    // Sanitize DB errors to avoid printing SQL internals or password-related details
                    if (err && err.code === 'ER_ACCESS_DENIED_ERROR') {
                        console.error('DB connection test failed at startup: access denied (check DB_USER/DB_PASSWORD/DB_HOST)');
                    } else {
                        // Print limited, non-sensitive fields for other errors
                        const safe = { code: err.code || 'UNKNOWN', errno: err.errno || null, message: err.message || 'DB error' };
                        console.error('DB connection test failed at startup:', safe);
                    }
                } else console.log('DB connection test succeeded');
            });
        }

        // Ensure optional AI/staff message tables exist to avoid runtime query errors
        try {
            db.query(`
                CREATE TABLE IF NOT EXISTS ai_messages (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    conversation_id INT,
                    sender VARCHAR(255),
                    message TEXT,
                    user_id INT,
                    created_at DATETIME DEFAULT NOW()
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
            `, (err) => { if (err) console.error('Error ensuring ai_messages table at startup:', err); else console.log('ai_messages table ensured at startup'); });

            db.query(`
                CREATE TABLE IF NOT EXISTS staff_messages (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    conversation_id INT,
                    sender VARCHAR(255),
                    message TEXT,
                    user_id INT,
                    created_at DATETIME DEFAULT NOW()
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
            `, (err) => { if (err) console.error('Error ensuring staff_messages table at startup:', err); else console.log('staff_messages table ensured at startup'); });
        } catch (e) {
            console.warn('Could not ensure ai/staff message tables at startup', e?.message || e);
        }
    } catch (e) {
        console.log(`✅🎲Server running on port ${PORT}🎲`);
    }
});

// Debug: force assign an escalation to a staff member (for testing handoff audio)
// POST /debug/assign-escalation  JSON: { conversationId, assignedStaffId, customerName }
app.post('/debug/assign-escalation', (req, res) => {
    const data = Object.assign({}, req.body || {}, req.query || {});
    const conversationId = data.conversationId || data.conversation_id;
    if (!conversationId) return res.status(400).json({ error: 'conversationId required' });

    let assignedStaffId = data.assignedStaffId || data.assigned_staff_id || null;
    // pick first available online staff if none provided
    if (!assignedStaffId) {
        const firstRec = Array.from(onlineAgents.values()).find(a => a && a.role === 'agent');
        assignedStaffId = firstRec ? firstRec.userId : null;
    }

    const customerName = data.customerName || `Debug:${conversationId}`;

    // (previously selected an audio file to play for handoffs; removed per request)

    // Upsert escalation row for visibility (best-effort)
    const upsertSql = isPg
        ? `INSERT INTO escalations (conversation_id, customer_name, alarm_active, assigned_staff_id) VALUES (?, ?, TRUE, ?) ON CONFLICT (conversation_id) DO UPDATE SET escalated_at = CURRENT_TIMESTAMP, alarm_active = TRUE, snoozed_until = NULL, claimed_by = NULL, claim_time = NULL, assigned_staff_id = ?`
        : `INSERT INTO escalations (conversation_id, customer_name, alarm_active, assigned_staff_id) VALUES (?, ?, 1, ?) ON DUPLICATE KEY UPDATE escalated_at = CURRENT_TIMESTAMP, alarm_active = 1, snoozed_until = NULL, claimed_by = NULL, claim_time = NULL, assigned_staff_id = ?`;

    db.query(upsertSql, [conversationId, customerName, assignedStaffId, assignedStaffId], (uErr) => {
        if (uErr) console.log('Debug escalation upsert error:', uErr);

        // Emit global escalationRaised and legacy handoffAlert
        io.emit('escalationRaised', { conversationId, customerName, assignedStaffId });
        io.emit('handoffAlert', { conversationId });

        // Notify assigned staff socket if online; otherwise broadcast to all online agents
        let assignedSocketId = null;
        if (assignedStaffId) {
            for (const [sockId, rec] of onlineAgents.entries()) {
                if (rec && String(rec.userId) === String(assignedStaffId)) {
                    assignedSocketId = sockId;
                    break;
                }
            }
                if (assignedSocketId) {
                    io.to(assignedSocketId).emit('escalationAssigned', { conversationId, customerName, assignedStaffId });
                } else {
                    // fallback: broadcast to all online agents
                    for (const [sockId, rec] of onlineAgents.entries()) {
                        if (rec && rec.role === 'agent') {
                            io.to(sockId).emit('escalationAssigned', { conversationId, customerName, assignedStaffId });
                        }
                    }
                }
        } else {
            // no assigned staff provided: broadcast to all online agents
            for (const [sockId, rec] of onlineAgents.entries()) {
                if (rec && rec.role === 'agent') {
                    io.to(sockId).emit('escalationAssigned', { conversationId, customerName, assignedStaffId: null });
                }
            }
        }

        return res.json({ ok: true, conversationId, assignedStaffId, assignedSocketId });
    });
});