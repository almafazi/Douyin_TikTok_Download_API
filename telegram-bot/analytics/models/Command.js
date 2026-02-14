import mongoose from 'mongoose';

const commandSchema = new mongoose.Schema({
  userId: {
    type: Number,
    required: true,
    index: true
  },
  command: {
    type: String,
    required: true,
    enum: ['start', 'help', 'stats', 'url', 'callback', 'adminstats']
  },
  responseTime: {
    type: Number,
    default: null
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

commandSchema.index({ timestamp: -1 });
commandSchema.index({ userId: 1, timestamp: -1 });
commandSchema.index({ command: 1, timestamp: -1 });

export const Command = mongoose.model('Command', commandSchema);
export default Command;
