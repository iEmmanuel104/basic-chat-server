// models/chat.ts
import { Schema, model, models } from "mongoose"

const ChatSchema = new Schema(
    {
        message: {
            type: String,
            required: true,
        },
        sender: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        groupId: {
            type: Schema.Types.ObjectId,
            ref: 'Group',
            required: true,
        },
        createdAt: {
            type: Date,
            default: Date.now
        },
        isDeleted: {
            type: Boolean,
            default: false
        }
    },
    { timestamps: true }
)

ChatSchema.index({ groupId: 1, createdAt: -1 });

export default models.Chat || model("Chat", ChatSchema)