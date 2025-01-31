//models/user.ts
import { Schema, model, models } from "mongoose"

const UserSchema = new Schema(
    {
        address: {
            type: String,
            unique: true,
            required: true,
        },
        winRate: {
            type: Number,
            default: 0,
        },
        wonTotalBets: {
            type: Number,
            default: 0,
        },
        totalBets: {
            type: Number,
            default: 0,
        },
        points: {
            type: Number,
            default: 0,
        },
    },
    { timestamps: true },
)


// Ensure only the correct index exists
UserSchema.index({ points: -1, winRate: -1 })
export default models.User || model("User", UserSchema)

