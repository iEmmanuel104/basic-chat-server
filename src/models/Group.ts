// models/group.ts
import { Schema, model, models } from "mongoose"

const GroupSchema = new Schema(
    {
        name: {
            type: String,
            required: true,
        },
        description: {
            type: String,
        },
        owner: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        members: [{
            type: Schema.Types.ObjectId,
            ref: 'User'
        }],
        isPrivate: {
            type: Boolean,
            default: false
        }
    },
    { timestamps: true }
)

GroupSchema.index({ name: 1 });
GroupSchema.index({ owner: 1 });

export default models.Group || model("Group", GroupSchema)