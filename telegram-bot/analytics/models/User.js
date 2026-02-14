import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  userId: {
    type: Number,
    required: true,
    unique: true,
    index: true
  },
  username: {
    type: String,
    default: null
  },
  firstName: {
    type: String,
    default: null
  },
  lastName: {
    type: String,
    default: null
  },
  firstSeen: {
    type: Date,
    default: Date.now
  },
  lastActive: {
    type: Date,
    default: Date.now
  },
  totalDownloads: {
    type: Number,
    default: 0
  },
  totalCommands: {
    type: Number,
    default: 0
  },
  isBlocked: {
    type: Boolean,
    default: false
  },
  languageCode: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

userSchema.index({ lastActive: -1 });
userSchema.index({ firstSeen: -1 });

export const User = mongoose.model('User', userSchema);
export default User;
