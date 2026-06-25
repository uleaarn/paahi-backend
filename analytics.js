import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const LOGS_DIR = process.env.ANALYTICS_LOG_DIR || path.join(__dirname, 'logs');
const RETENTION_DAYS = parseInt(process.env.ANALYTICS_RETENTION_DAYS || '30');

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    console.log(`📁 Created logs directory: ${LOGS_DIR}`);
}

/**
 * Call Analytics System
 * Tracks call metadata, transcripts, and KPIs
 */
class CallAnalytics {
    constructor() {
        this.logsDir = LOGS_DIR;
        this.retentionDays = RETENTION_DAYS;
    }

    /**
     * Log a complete call with all metadata
     * @param {Object} callData - Call information
     * @param {string} callData.callId - Unique call identifier (Twilio streamSid)
     * @param {string} callData.startTime - ISO timestamp when call started
     * @param {string} callData.endTime - ISO timestamp when call ended
     * @param {number} callData.duration - Call duration in seconds
     * @param {Array} callData.transcript - Full conversation history
     * @param {boolean} callData.orderCompleted - Whether order was successfully placed
     * @param {Object} callData.orderData - Order details if completed
     * @param {string} callData.customerName - Customer name if provided
     * @param {string} callData.customerPhone - Customer phone if provided
     * @param {string} callData.failureReason - Reason if call failed
     */
    logCall(callData) {
        try {
            const timestamp = new Date().toISOString();
            const dateStr = timestamp.split('T')[0]; // YYYY-MM-DD
            const logFile = path.join(this.logsDir, `calls-${dateStr}.json`);

            // Prepare call record
            const callRecord = {
                callId: callData.callId,
                startTime: callData.startTime,
                endTime: callData.endTime,
                duration: callData.duration,
                orderCompleted: callData.orderCompleted || false,
                customerName: callData.customerName || null,
                customerPhone: callData.customerPhone || null,
                transcript: callData.transcript || [],
                orderData: callData.orderData || null,
                failureReason: callData.failureReason || null,
                metadata: {
                    transcriptLength: callData.transcript?.length || 0,
                    itemsOrdered: callData.orderData?.items?.length || 0,
                    loggedAt: timestamp
                }
            };

            // Read existing logs for the day
            let dailyLogs = [];
            if (fs.existsSync(logFile)) {
                const content = fs.readFileSync(logFile, 'utf-8');
                dailyLogs = JSON.parse(content);
            }

            // Append new call
            dailyLogs.push(callRecord);

            // Write back to file
            fs.writeFileSync(logFile, JSON.stringify(dailyLogs, null, 2));

            console.log(`📊 Call logged: ${callData.callId} (${callData.orderCompleted ? 'SUCCESS' : 'INCOMPLETE'})`);

            return { success: true, logFile };

        } catch (error) {
            console.error('❌ Failed to log call:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get all calls within a time range
     * @param {Date} startDate - Start date
     * @param {Date} endDate - End date
     * @returns {Array} Array of call records
     */
    getCalls(startDate = null, endDate = null) {
        try {
            const now = new Date();
            const start = startDate || new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // Default: last 7 days
            const end = endDate || now;

            const allCalls = [];
            const files = fs.readdirSync(this.logsDir);

            for (const file of files) {
                if (!file.startsWith('calls-') || !file.endsWith('.json')) continue;

                const filePath = path.join(this.logsDir, file);
                const content = fs.readFileSync(filePath, 'utf-8');
                const dailyCalls = JSON.parse(content);

                // Filter by date range
                const filteredCalls = dailyCalls.filter(call => {
                    const callDate = new Date(call.startTime);
                    return callDate >= start && callDate <= end;
                });

                allCalls.push(...filteredCalls);
            }

            // Sort by start time (most recent first)
            allCalls.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

            return allCalls;

        } catch (error) {
            console.error('❌ Failed to get calls:', error);
            return [];
        }
    }

    /**
     * Get recent calls (limit)
     * @param {number} limit - Maximum number of calls to return
     * @returns {Array} Array of recent call records
     */
    getRecentCalls(limit = 10) {
        const allCalls = this.getCalls();
        return allCalls.slice(0, limit);
    }

    /**
     * Calculate aggregated statistics
     * @param {Date} startDate - Start date for stats
     * @param {Date} endDate - End date for stats
     * @returns {Object} Statistics object
     */
    getStats(startDate = null, endDate = null) {
        try {
            const calls = this.getCalls(startDate, endDate);

            if (calls.length === 0) {
                return {
                    totalCalls: 0,
                    completedOrders: 0,
                    failedCalls: 0,
                    successRate: 0,
                    averageDuration: 0,
                    averageItemsPerOrder: 0,
                    totalRevenue: 0
                };
            }

            const completedOrders = calls.filter(c => c.orderCompleted).length;
            const failedCalls = calls.filter(c => !c.orderCompleted).length;
            const totalDuration = calls.reduce((sum, c) => sum + (c.duration || 0), 0);
            const ordersWithItems = calls.filter(c => c.orderData?.items?.length > 0);
            const totalItems = ordersWithItems.reduce((sum, c) => sum + c.orderData.items.length, 0);

            return {
                totalCalls: calls.length,
                completedOrders,
                failedCalls,
                successRate: ((completedOrders / calls.length) * 100).toFixed(2),
                averageDuration: (totalDuration / calls.length).toFixed(1),
                averageItemsPerOrder: ordersWithItems.length > 0
                    ? (totalItems / ordersWithItems.length).toFixed(1)
                    : 0,
                timeRange: {
                    start: startDate?.toISOString() || calls[calls.length - 1]?.startTime,
                    end: endDate?.toISOString() || calls[0]?.startTime
                }
            };

        } catch (error) {
            console.error('❌ Failed to calculate stats:', error);
            return null;
        }
    }

    /**
     * Get detailed KPIs
     * @returns {Object} KPI metrics
     */
    getKPIs() {
        try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);
            const lastWeek = new Date(today);
            lastWeek.setDate(lastWeek.getDate() - 7);

            const todayStats = this.getStats(today, new Date());
            const yesterdayStats = this.getStats(yesterday, today);
            const weekStats = this.getStats(lastWeek, new Date());

            return {
                today: todayStats,
                yesterday: yesterdayStats,
                last7Days: weekStats,
                trends: {
                    callsChange: todayStats.totalCalls - yesterdayStats.totalCalls,
                    successRateChange: (todayStats.successRate - yesterdayStats.successRate).toFixed(2)
                }
            };

        } catch (error) {
            console.error('❌ Failed to get KPIs:', error);
            return null;
        }
    }

    /**
     * Clean up old log files based on retention policy
     */
    cleanupOldLogs() {
        try {
            const now = new Date();
            const cutoffDate = new Date(now.getTime() - this.retentionDays * 24 * 60 * 60 * 1000);
            const files = fs.readdirSync(this.logsDir);

            let deletedCount = 0;

            for (const file of files) {
                if (!file.startsWith('calls-') || !file.endsWith('.json')) continue;

                // Extract date from filename (calls-YYYY-MM-DD.json)
                const dateStr = file.replace('calls-', '').replace('.json', '');
                const fileDate = new Date(dateStr);

                if (fileDate < cutoffDate) {
                    const filePath = path.join(this.logsDir, file);
                    fs.unlinkSync(filePath);
                    deletedCount++;
                    console.log(`🗑️ Deleted old log file: ${file}`);
                }
            }

            if (deletedCount > 0) {
                console.log(`✅ Cleaned up ${deletedCount} old log files`);
            }

            return { deletedCount };

        } catch (error) {
            console.error('❌ Failed to cleanup old logs:', error);
            return { deletedCount: 0, error: error.message };
        }
    }
}

// Export singleton instance
const analytics = new CallAnalytics();
export default analytics;
