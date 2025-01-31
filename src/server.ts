// server/src/index.ts
import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import dotenv from 'dotenv';
import Group from './models/Group';
import Chat from './models/Chat';
import User from './models/User';

// Define message type
interface MessageType {
    _id: string;
    message: string;
    sender: { address: string };
    createdAt: Date | string;
    groupId: string;
}

interface ServerToClientEvents {
    message: (message: MessageType) => void;
    connectionEstablished: (data: { connectionId: string }) => void;
    error: (error: string) => void;
}

interface ClientToServerEvents {
    joinGroup: (groupId: string) => void;
    leaveGroup: (groupId: string) => void;
    sendMessage: (data: { groupId: string; message: string }) => void;
    getGroups: (callback: (groups: any[]) => void) => void;
    createGroup: (data: { name: string; description?: string }, callback: (group: any) => void) => void;
    loadMessages: (data: { groupId: string; before?: string }, callback: (messages: MessageType[]) => void) => void;
}

interface InterServerEvents {
    ping: () => void;
}

interface SocketData {
    user: {
        _id: mongoose.Types.ObjectId;
        address: string;
    };
}

// Load environment variables
dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
const REDIS_URL = process.env.REDIS_CONNECTION_URL || 'redis://localhost:6379';

if (!MONGODB_URI) {
    throw new Error('Please define the MONGODB_URI environment variable');
}

const app = express();
const httpServer = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(httpServer, {
    cors: {
        origin: "*",
        methods: ["*"],
        credentials: true,
        allowedHeaders: ["*"]
    }
});

// Redis client configuration
const redisClient = new Redis(REDIS_URL, {
    retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
    },
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    reconnectOnError: (err) => {
        const targetError = 'READONLY';
        if (err.message.includes(targetError)) {
            return true;
        }
        return false;
    }
});

redisClient.on('connect', () => {
    console.log('Connected to Redis successfully');
});

redisClient.on('error', (error) => {
    console.error('Redis Client Error:', error);
});

redisClient.on('ready', () => {
    console.log('Redis client is ready');
});

// Redis helper functions
const redisHelpers = {
    async addUserToGroup(groupId: string, socketId: string, userAddress: string) {
        const key = `group:${groupId}:users`;
        return await redisClient.hset(key, socketId, userAddress);
    },

    async removeUserFromGroup(groupId: string, socketId: string) {
        const key = `group:${groupId}:users`;
        await redisClient.hdel(key, socketId);
        const remaining = await redisClient.hlen(key);
        if (remaining === 0) {
            await redisClient.del(key);
        }
    },

    async getGroupUsers(groupId: string) {
        const key = `group:${groupId}:users`;
        return await redisClient.hgetall(key);
    },

    async addUserConnection(socketId: string, userAddress: string) {
        return await redisClient.hset('user_connections', socketId, userAddress);
    },

    async removeUserConnection(socketId: string) {
        return await redisClient.hdel('user_connections', socketId);
    },

    async cleanup(socketId: string) {
        const groupKeys = await redisClient.keys('group:*:users');

        for (const key of groupKeys) {
            await redisClient.hdel(key, socketId);
            const remaining = await redisClient.hlen(key);
            if (remaining === 0) {
                await redisClient.del(key);
            }
        }

        await redisClient.hdel('user_connections', socketId);
    }
};

// Socket.IO middleware and event handlers
const setupSocketIO = () => {
    io.use(async (socket, next) => {
        try {
            const token = socket.handshake.auth.token;
            if (!token) {
                return next(new Error('Authentication token required'));
            }

            const user = await User.findOne({ address: token });
            if (!user) {
                return next(new Error('Authentication failed'));
            }

            socket.data.user = user;
            next();
        } catch (error) {
            next(new Error('Authentication failed'));
        }
    });

    io.on('connection', async (socket) => {
        const user = socket.data.user;
        await redisHelpers.addUserConnection(socket.id, user.address);

        socket.emit('connectionEstablished', {
            connectionId: socket.id
        });

        socket.on('getGroups', async (callback) => {
            try {
                const allGroups = await Group.find({ isPrivate: false })
                    .populate('owner', 'address')
                    .populate('members', 'address')
                    .sort({ createdAt: -1 });

                const userGroups = allGroups.filter(group =>
                    group.members.some((member: { _id: mongoose.Types.ObjectId }) =>
                        member._id.toString() === user._id.toString())
                );
                const otherGroups = allGroups.filter(group =>
                    !group.members.some((member: { _id: mongoose.Types.ObjectId }) =>
                        member._id.toString() === user._id.toString())
                );

                callback([...userGroups, ...otherGroups]);
            } catch (error) {
                console.error('Error fetching groups:', error);
                callback([]);
            }
        });

        socket.on('createGroup', async (data, callback) => {
            try {
                const group = await Group.create({
                    name: data.name,
                    description: data.description,
                    owner: user._id,
                    members: [user._id],
                    isPrivate: false
                });

                await group.populate('owner', 'address');
                await group.populate('members', 'address');

                callback(group);
            } catch (error) {
                console.error('Error creating group:', error);
                callback(null);
            }
        });

        socket.on('joinGroup', async (groupId) => {
            try {
                await redisHelpers.addUserToGroup(groupId, socket.id, user.address);

                const group = await Group.findById(groupId);
                if (group && !group.members.includes(user._id)) {
                    group.members.push(user._id);
                    await group.save();
                }

                await socket.join(groupId);
            } catch (error) {
                console.error('Error joining group:', error);
                socket.emit('error', 'Failed to join group');
            }
        });

        socket.on('leaveGroup', async (groupId) => {
            try {
                await redisHelpers.removeUserFromGroup(groupId, socket.id);
                await socket.leave(groupId);
            } catch (error) {
                console.error('Error leaving group:', error);
                socket.emit('error', 'Failed to leave group');
            }
        });

        socket.on('sendMessage', async (data) => {
            try {
                const chat = await Chat.create({
                    message: data.message,
                    sender: user._id,
                    groupId: data.groupId
                });

                await chat.populate('sender', 'address');

                const messageData: MessageType = {
                    _id: chat._id.toString(),
                    message: chat.message,
                    sender: { address: user.address },
                    createdAt: chat.createdAt,
                    groupId: chat.groupId.toString()
                };

                io.to(data.groupId).emit('message', messageData);
            } catch (error) {
                console.error('Error sending message:', error);
                socket.emit('error', 'Failed to send message');
            }
        });

        socket.on('loadMessages', async (data, callback) => {
            try {
                const query = {
                    groupId: data.groupId,
                    isDeleted: false,
                    ...(data.before && { _id: { $lt: data.before } })
                };

                const messages = await Chat.find(query)
                    .populate('sender', 'address')
                    .sort({ createdAt: -1 })
                    .limit(50);

                const formattedMessages = messages.map(msg => ({
                    _id: msg._id.toString(),
                    message: msg.message,
                    sender: { address: msg.sender.address },
                    createdAt: msg.createdAt,
                    groupId: msg.groupId.toString()
                }));

                callback(formattedMessages);
            } catch (error) {
                console.error('Error loading messages:', error);
                callback([]);
            }
        });

        socket.on('disconnect', async () => {
            await redisHelpers.cleanup(socket.id);
        });
    });
};

// Initialize function that ensures connections before starting the server
const initialize = async () => {
    try {
        // Connect to MongoDB
        await mongoose.connect(MONGODB_URI);
        console.log('Connected to MongoDB successfully');

        // Set up Socket.IO (Redis is already connected via events)
        setupSocketIO();

        // Start the server
        const PORT = process.env.PORT || 4000;
        httpServer.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });
    } catch (error) {
        console.error('Failed to initialize server:', error);
        process.exit(1);
    }
};

// Handle cleanup on server shutdown
process.on('SIGINT', async () => {
    try {
        await Promise.all([
            redisClient.disconnect(),
            mongoose.connection.close()
        ]);
        console.log('Cleaned up connections');
        process.exit(0);
    } catch (error) {
        console.error('Error during cleanup:', error);
        process.exit(1);
    }
});

// Start the initialization
initialize();