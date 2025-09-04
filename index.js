const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const { z } = require("zod");
const fetch = require("node-fetch"); // For calling Python payout service
const { smsService } = require("./sms");

// Add request logging middleware
const requestLogger = (req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path} - ${req.ip}`);
  next();
};

// Simple rate limiting for OTP endpoints
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 5; // 5 requests per minute

const rateLimit = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  
  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return next();
  }
  
  const rateLimitData = rateLimitMap.get(ip);
  
  if (now > rateLimitData.resetTime) {
    rateLimitData.count = 1;
    rateLimitData.resetTime = now + RATE_LIMIT_WINDOW;
    return next();
  }
  
  if (rateLimitData.count >= RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({ 
      error: "Too many requests. Please try again later.",
      retryAfter: Math.ceil((rateLimitData.resetTime - now) / 1000)
    });
  }
  
  rateLimitData.count++;
  next();
};

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
} catch (e) {
  console.error("❌ Firebase key error:", e.message);
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();
const usersRef = db.collection("users");
const phoneNumbersRef = db.collection("phone_numbers");
const otpRef = db.collection("otp_verifications");
const walletRef = db.collection("wallet_transactions");
const wastePricesRef = db.collection("waste_prices");
const processedRequestsRef = db.collection("processed_requests");

const app = express();
app.use(cors());
app.use(express.json());
app.use(requestLogger);

app.get("/health", (_, res) => res.json({ 
  status: "ok", 
  timestamp: new Date().toISOString(),
  service: "functions-service",
  version: "1.0.0"
}));

// --- Auth middleware (verifies Firebase ID token in Authorization: Bearer <token>) ---
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const m = header.match(/^Bearer\s+(.*)$/i);
    if (!m) return res.status(401).json({ error: "Missing Bearer token" });
    const decoded = await admin.auth().verifyIdToken(m[1]);
    req.user = decoded; // includes uid
    return next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token", details: e.message });
  }
}

async function assertAdmin(req, res, next) {
  try {
    if (!req.user || !req.user.uid) return res.status(401).json({ error: "Unauthenticated" });
    // Prefer custom claim
    if (req.user.admin === true) return next();
    // Fallback to Firestore role
    const snap = await usersRef.doc(req.user.uid).get();
    if (snap.exists && snap.data().role === 'admin') return next();
    return res.status(403).json({ error: 'Admin only' });
  } catch (e) {
    return res.status(500).json({ error: 'Role check failed', details: e.message });
  }
}

// --- Push Notifications Helpers ---
async function sendToUserToken(userId, notification, data = {}) {
  try {
    const snap = await usersRef.doc(userId).get();
    if (!snap.exists) return { success: false, error: "User not found" };
    const token = snap.data().fcmToken;
    if (!token) return { success: false, error: "No fcmToken" };
    await admin.messaging().send({
      token,
      notification,
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function sendToAdmins(notification, data = {}) {
  try {
    await admin.messaging().send({
      topic: "admins",
      notification,
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// 📊 Analytics Endpoints
app.get("/analytics/users", async (req, res) => {
  try {
    const usersSnapshot = await usersRef.get();
    const totalUsers = usersSnapshot.size;
    
    let verifiedUsers = 0;
    let totalWalletBalance = 0;
    let totalRecycledWeight = 0;
    let totalCo2Saved = 0;
    
    usersSnapshot.forEach(doc => {
      const data = doc.data();
      if (data.phoneVerified) verifiedUsers++;
      if (data.walletBalance) totalWalletBalance += data.walletBalance;
      if (data.recycledWeight) totalRecycledWeight += data.recycledWeight;
      if (data.co2Saved) totalCo2Saved += data.co2Saved;
    });
    
    res.json({
      total_users: totalUsers,
      verified_users: verifiedUsers,
      verification_rate: totalUsers > 0 ? (verifiedUsers / totalUsers * 100).toFixed(2) : 0,
      total_wallet_balance: totalWalletBalance,
      total_recycled_weight: totalRecycledWeight,
      total_co2_saved: totalCo2Saved,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error("Analytics error:", err);
    res.status(500).json({ error: "Failed to fetch user analytics" });
  }
});

app.get("/analytics/transactions", async (req, res) => {
  try {
    const transactionsSnapshot = await walletRef.get();
    const totalTransactions = transactionsSnapshot.size;
    
    let totalAmount = 0;
    const typeCounts = {};
    const statusCounts = {};
    
    transactionsSnapshot.forEach(doc => {
      const data = doc.data();
      if (data.amount) totalAmount += Math.abs(data.amount);
      
      const type = data.type || 'unknown';
      typeCounts[type] = (typeCounts[type] || 0) + 1;
      
      const status = data.status || 'unknown';
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    });
    
    res.json({
      total_transactions: totalTransactions,
      total_amount: totalAmount,
      type_breakdown: typeCounts,
      status_breakdown: statusCounts,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error("Analytics error:", err);
    res.status(500).json({ error: "Failed to fetch transaction analytics" });
  }
});

// Transactions query with filters and pagination
app.get("/transactions/query", async (req, res) => {
  try {
    const {
      type = "any",
      status = "any",
      start,
      end,
      search = "",
      limit = "100",
      startAfter: startAfterId,
      wasteType = "any",
    } = req.query;

    const parsedLimit = Math.max(1, Math.min(parseInt(limit, 10) || 100, 500));

    let query = walletRef.orderBy("timestamp", "desc");
    if (start) {
      const startDate = new Date(start);
      if (!isNaN(startDate.getTime())) {
        query = query.where("timestamp", ">=", admin.firestore.Timestamp.fromDate(startDate));
      }
    }
    if (end) {
      const endDate = new Date(end);
      if (!isNaN(endDate.getTime())) {
        query = query.where("timestamp", "<=", admin.firestore.Timestamp.fromDate(endDate));
      }
    }

    if (startAfterId) {
      const docSnap = await walletRef.doc(startAfterId).get();
      if (docSnap.exists) {
        query = query.startAfter(docSnap);
      }
    }

    const snap = await query.limit(parsedLimit).get();
    let items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const loweredSearch = String(search || "").toLowerCase();

    // In-memory filters for type/status/search to avoid composite index requirements
    items = items.filter((it) => {
      if (type !== "any" && String(it.type || "") !== type) return false;
      if (status !== "any" && String(it.status || "") !== status) return false;
      if (wasteType !== "any" && String(it.wasteType || "") !== wasteType) return false;
      if (loweredSearch) {
        const hay = `${String(it.details || "").toLowerCase()} ${String(it.userId || "").toLowerCase()} ${String(it.wasteType || "").toLowerCase()}`;
        if (!hay.includes(loweredSearch)) return false;
      }
      return true;
    });

    const nextPageToken = snap.size === parsedLimit ? snap.docs[snap.docs.length - 1].id : null;
    return res.json({ items, nextPageToken, count: items.length });
  } catch (err) {
    console.error("Transactions query error:", err);
    return res.status(500).json({ error: "Failed to query transactions", details: err.message });
  }
});

// Transactions export as CSV
app.get("/transactions/export", async (req, res) => {
  try {
    const { type = "any", status = "any", start, end, search = "", limit = "1000", wasteType = "any" } = req.query;
    const max = Math.max(1, Math.min(parseInt(limit, 10) || 1000, 5000));

    let query = walletRef.orderBy("timestamp", "desc");
    if (start) {
      const startDate = new Date(start);
      if (!isNaN(startDate.getTime())) {
        query = query.where("timestamp", ">=", admin.firestore.Timestamp.fromDate(startDate));
      }
    }
    if (end) {
      const endDate = new Date(end);
      if (!isNaN(endDate.getTime())) {
        query = query.where("timestamp", "<=", admin.firestore.Timestamp.fromDate(endDate));
      }
    }

    let collected = [];
    let pageQuery = query.limit(Math.min(max, 500));
    let lastDoc = null;
    while (collected.length < max) {
      const snap = await pageQuery.get();
      if (snap.empty) break;
      const batch = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      collected = collected.concat(batch);
      lastDoc = snap.docs[snap.docs.length - 1];
      pageQuery = query.startAfter(lastDoc).limit(Math.min(max - collected.length, 500));
      if (snap.size < 1) break;
    }

    const loweredSearch = String(search || "").toLowerCase();
    let rows = collected.filter((it) => {
      if (type !== "any" && String(it.type || "") !== type) return false;
      if (status !== "any" && String(it.status || "") !== status) return false;
      if (wasteType !== "any" && String(it.wasteType || "") !== wasteType) return false;
      if (loweredSearch) {
        const hay = `${String(it.details || "").toLowerCase()} ${String(it.userId || "").toLowerCase()} ${String(it.wasteType || "").toLowerCase()}`;
        if (!hay.includes(loweredSearch)) return false;
      }
      return true;
    });

    // CSV header
    const header = [
      "id",
      "userId",
      "type",
      "status",
      "amount",
      "wasteType",
      "weight",
      "phone",
      "details",
      "relatedRequest",
      "timestamp",
    ];

    const toCsv = (val) => {
      if (val === null || val === undefined) return "";
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const lines = [header.join(",")];
    for (const it of rows) {
      const ts = it.timestamp && it.timestamp.toDate ? it.timestamp.toDate().toISOString() : "";
      lines.push([
        it.id,
        it.userId || "",
        it.type || "",
        it.status || "",
        it.amount != null ? it.amount : "",
        it.wasteType || "",
        it.weight != null ? it.weight : "",
        it.phone || "",
        it.details || "",
        it.relatedRequest || "",
        ts,
      ].map(toCsv).join(","));
    }

    const csv = lines.join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=transactions.csv");
    return res.status(200).send(csv);
  } catch (err) {
    console.error("Transactions export error:", err);
    return res.status(500).json({ error: "Failed to export transactions", details: err.message });
  }
});

// Notify admins when a new recycling request is created (called from client)
app.post("/request-created", requireAuth, async (req, res) => {
  try {
    const { userId, requestId, wasteType } = req.body || {};
    if (!userId || !requestId) return res.status(400).json({ error: "Missing userId or requestId" });
    await sendToAdmins({
      title: "New Pickup Request",
      body: `User ${userId} requested pickup${wasteType ? ` (${wasteType})` : ""}`,
    }, { requestId, userId });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Notify user when their request is accepted by admin (called from admin client)
app.post("/request-accepted", requireAuth, assertAdmin, async (req, res) => {
  try {
    const { userId, requestId, wasteType } = req.body || {};
    if (!userId || !requestId) return res.status(400).json({ error: "Missing userId or requestId" });
    await sendToUserToken(userId, {
      title: "Pickup Accepted",
      body: `Your pickup request${wasteType ? ` (${wasteType})` : ""} was accepted.`,
    }, { route: "/recycling_requests", requestId });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Recycling analytics: kg per waste type, totals, and last 12 months trend
app.get("/analytics/recycling", async (req, res) => {
  try {
    // Aggregate from users for totals
    const usersSnapshot = await usersRef.get();
    let totalKg = 0;
    let totalCo2 = 0;
    let totalPaid = 0;

    usersSnapshot.forEach((doc) => {
      const d = doc.data();
      if (d.recycledWeight) totalKg += d.recycledWeight;
      if (d.co2Saved) totalCo2 += d.co2Saved;
    });

    // Aggregate amounts paid from wallet transactions: Recycle Credit
    const txSnap = await walletRef.where("type", "==", "Recycle Credit").get();
    let totalCo2FromTx = 0;
    txSnap.forEach((doc) => {
      const d = doc.data();
      if (d.amount) totalPaid += d.amount;
    });

    // Per-type breakdown: infer from wallet_transactions details field and/or waste_prices
    const typeBreakdown = {};
    let totalKgFromTx = 0;
    txSnap.forEach((doc) => {
      const d = doc.data();
      // Prefer explicit weight field when present; otherwise parse from details
      let kg = 0;
      let type = (d.wasteType || "").toString();
      if (typeof d.weight === "number") {
        kg = d.weight;
      } else {
        const details = (d.details || "").toString();
        const match = details.match(/recycling\s+(\d+(?:\.\d+)?)kg\s+of\s+([A-Za-z\s]+)/i);
        if (match) {
          kg = parseFloat(match[1]);
          if (!type) type = match[2].trim();
        }
      }
      if (kg > 0) {
        totalKgFromTx += kg;
        totalCo2FromTx += kg * 1.5;
        if (type) {
          typeBreakdown[type] = (typeBreakdown[type] || 0) + kg;
        }
      }
    });

    // Monthly trend for last 12 months from wallet_transactions timestamps
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    const monthly = {};
    txSnap.forEach((doc) => {
      const d = doc.data();
      const ts = d.timestamp && d.timestamp.toDate ? d.timestamp.toDate() : null;
      const details = (d.details || "").toString();
      const m = details.match(/recycling\s+(\d+(?:\.\d+)?)kg/i);
      const kg = m ? parseFloat(m[1]) : 0;
      if (!ts || isNaN(kg)) return;
      if (ts < start) return;
      const key = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, "0")}`;
      monthly[key] = (monthly[key] || 0) + kg;
    });

    // Normalize last 12 months keys
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      months.push(key);
    }
    const monthlyKg = months.map((k) => ({ month: k, kg: monthly[k] || 0 }));

    return res.json({
      totals: {
        // Prefer transaction-derived total when available to avoid stale user aggregates
        kg: totalKgFromTx > 0 ? totalKgFromTx : totalKg,
        co2: totalCo2FromTx > 0 ? totalCo2FromTx : totalCo2,
        amount_paid: totalPaid,
      },
      per_type_kg: typeBreakdown,
      monthly_kg: monthlyKg,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Analytics error:", err);
    return res.status(500).json({ error: "Failed to fetch recycling analytics" });
  }
});

app.use((err, req, res, next) => {
  console.error("🔥 Server Error:", err.stack);
  res.status(500).json({ error: "Internal server error" });
});

// --- Phone Number Normalization ---
function normalizeKenyanNumber(input) {
  let number = String(input).trim().replace(/\s+/g, "");
  if (number.startsWith("+")) number = number.substring(1);
  if (number.startsWith("254") && number.length === 12) return number;
  if (number.startsWith("0") && number.length === 10) return "254" + number.substring(1);
  if ((number.startsWith("7") || number.startsWith("1")) && number.length === 9) return "254" + number;
  return number;
}

// Check verification status endpoint
app.post("/check-verification", async (req, res) => {
  try {
    const schema = z.object({
      phoneNumber: z.string().min(10),
    });
    
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    
    const { phoneNumber } = parsed.data;
    const normalizedPhone = normalizeKenyanNumber(phoneNumber);
    
    // Check if user exists and is verified
    const userQuery = await usersRef.where("phoneNumber", "==", normalizedPhone).limit(1).get();
    
    if (userQuery.empty) {
      return res.json({ 
        verified: false, 
        message: "Phone number not found. Please verify your number first." 
      });
    }
    
    const userData = userQuery.docs[0].data();
    const isVerified = userData.phoneVerified === true;
    
    return res.json({
      verified: isVerified,
      phoneNumber: normalizedPhone,
      userId: userQuery.docs[0].id,
      message: isVerified ? "Phone number is verified" : "Please verify your number first"
    });
    
  } catch (err) {
    console.error("❌ Check Verification Error:", err);
    return res.status(500).json({ error: "Failed to check verification status", details: err.message });
  }
});

// OTP endpoints with rate limiting
app.post("/send-otp", rateLimit, async (req, res) => {
  try {
    const schema = z.object({ phoneNumber: z.string().min(10) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    
    const { phoneNumber } = parsed.data;
    const normalizedPhone = normalizeKenyanNumber(phoneNumber);
    const otp = Math.floor(100000 + Math.random() * 900000);
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes expiry
    
    // Use phone number as document ID to ensure proper retrieval
    await otpRef.doc(normalizedPhone).set({
      phoneNumber: normalizedPhone,
      otp: otp.toString(), // Store as string for consistent comparison
      expiresAt,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      attempts: 0 // Track verification attempts
    });
    
    // Send OTP via SMS
    const response = await smsService.sendSms(normalizedPhone, `Your verification code is ${otp}`);
    console.log(`📱 OTP ${otp} sent to ${normalizedPhone}`);
    
    return res.json({ success: true, message: "OTP sent", response });
  } catch (err) {
    console.error("❌ Send OTP Error:", err);
    return res.status(500).json({ error: "Failed to send OTP", details: err.message });
  }
});

app.post("/verify-otp", rateLimit, async (req, res) => {
  try {
    const schema = z.object({
      phoneNumber: z.string().min(10),
      otp: z.string().min(6).max(6),
      userId: z.string().optional(),
    });
    
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    
    const { phoneNumber, otp, userId } = parsed.data;
    const normalizedPhone = normalizeKenyanNumber(phoneNumber);
    
    console.log(`🔍 Verifying OTP for ${normalizedPhone}`);
    
    // Get OTP document using phone number as document ID
    const docRef = otpRef.doc(normalizedPhone);
    const doc = await docRef.get();
    
    if (!doc.exists) {
      console.log(`❌ No OTP document found for ${normalizedPhone}`);
      return res.status(400).json({ error: "No OTP found" });
    }
    
    const data = doc.data();
    console.log(`📋 Found OTP data:`, { 
      storedOTP: data.otp, 
      receivedOTP: otp, 
      expiresAt: new Date(data.expiresAt),
      attempts: data.attempts 
    });
    
    // Check for too many attempts (rate limiting)
    if (data.attempts >= 3) {
      await docRef.delete();
      return res.status(400).json({ error: "Too many failed attempts. Please request a new OTP." });
    }
    
    // Check expiration
    if (Date.now() > data.expiresAt) {
      await docRef.delete();
      console.log(`⏰ OTP expired for ${normalizedPhone}`);
      return res.status(400).json({ error: "OTP expired" });
    }
    
    // Verify OTP (ensure both are strings for comparison)
    const storedOTP = data.otp.toString().trim();
    const providedOTP = otp.toString().trim();
    
    if (storedOTP !== providedOTP) {
      // Increment failed attempts
      await docRef.update({
        attempts: admin.firestore.FieldValue.increment(1)
      });
      console.log(`❌ Invalid OTP for ${normalizedPhone}. Expected: ${storedOTP}, Got: ${providedOTP}`);
      return res.status(400).json({ error: "Invalid OTP" });
    }
    
    // OTP is valid - update user verification status and delete OTP document
    await docRef.delete();
    console.log(`✅ OTP verified successfully for ${normalizedPhone}`);
    
    // If a specific userId is provided, bind phone to that user with uniqueness
    if (userId) {
      await db.runTransaction(async (tx) => {
        const mapRef = phoneNumbersRef.doc(normalizedPhone);
        const mapSnap = await tx.get(mapRef);
        if (mapSnap.exists && mapSnap.data().ownerUid && mapSnap.data().ownerUid !== userId) {
          throw new Error("Phone number already in use");
        }
        tx.set(mapRef, {
          ownerUid: userId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        const userRef = usersRef.doc(userId);
        tx.set(userRef, {
          phoneNumber: normalizedPhone,
          phoneVerified: true,
          lastVerified: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      });
      console.log(`🔒 Bound phone ${normalizedPhone} to user ${userId}`);
    } else {
      // No userId context; only return verified=true so client can bind securely later
      console.log("⚠️ No userId provided during verify-otp; skipping binding.");
    }
    
    return res.json({ 
      success: true,
      verified: true, // Add this for Flutter compatibility
      message: "OTP verified successfully",
      phoneVerified: true,
      phoneNumber: normalizedPhone
    });
    
  } catch (err) {
    console.error("❌ Verify OTP Error:", err);
    return res.status(500).json({ error: "Verification failed", details: err.message });
  }
});

// Reserve (bind) a phone number to a user atomically and uniquely
app.post("/reserve-phone", async (req, res) => {
  try {
    const schema = z.object({
      userId: z.string(),
      phoneNumber: z.string().min(10),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    const { userId, phoneNumber } = parsed.data;
    const normalizedPhone = normalizeKenyanNumber(phoneNumber);

    await db.runTransaction(async (tx) => {
      const mapRef = phoneNumbersRef.doc(normalizedPhone);
      const mapSnap = await tx.get(mapRef);
      if (mapSnap.exists && mapSnap.data().ownerUid && mapSnap.data().ownerUid !== userId) {
        throw new Error("Phone number already in use");
      }
      tx.set(mapRef, {
        ownerUid: userId,
        reservedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      const userRef = usersRef.doc(userId);
      tx.set(userRef, {
        phoneNumber: normalizedPhone,
      }, { merge: true });
    });

    return res.json({ success: true, phoneNumber: normalizedPhone });
  } catch (err) {
    const code = /already in use/i.test(err.message) ? 409 : 500;
    return res.status(code).json({ error: err.message });
  }
});

// Withdraw endpoint
app.post("/withdraw", async (req, res) => {
  try {
    const schema = z.object({
      userId: z.string(),
      amount: z.number().positive(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    const { userId, amount } = parsed.data;
    const userRef = usersRef.doc(userId);
    await db.runTransaction(async (tx) => {
      const userDoc = await tx.get(userRef);
      if (!userDoc.exists) throw new Error("User not found");
      const balance = userDoc.data().walletBalance || 0;
      if (amount > balance) throw new Error("Insufficient balance");
      tx.update(userRef, { walletBalance: balance - amount });
      tx.set(walletRef.doc(), {
        userId,
        type: "Withdraw",
        amount: -amount,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        status: "completed",
      });
    });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// B2C endpoint: deduct wallet, log transaction, then call Python payout service
app.post("/b2c", async (req, res) => {
  try {
    const schema = z.object({
      user_id: z.string(),
      phone: z.string().min(10),
      amount: z.number().positive(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    const { user_id, phone, amount } = parsed.data;
    const normalizedPhone = normalizeKenyanNumber(phone);
    const userRef = usersRef.doc(user_id);
    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new Error("User not found");
      const balance = userSnap.data().walletBalance || 0;
      if (amount > balance) throw new Error("Insufficient balance");
      tx.update(userRef, { walletBalance: balance - amount });
      tx.set(walletRef.doc(), {
        userId: user_id,
        type: "Withdraw",
        amount: -amount,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        status: "pending",
        method: "B2C",
        phone: normalizedPhone,
      });
    });
    // Call Python payout service after wallet deduction
    let payoutResult = null;
    try {
      const payoutResponse = await fetch("https://payment-service-a3t5.onrender.com/b2c", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id,
          phone: normalizedPhone,
          amount
        }),
      });
      payoutResult = await payoutResponse.json();
    } catch (payoutErr) {
      payoutResult = { success: false, error: payoutErr.message };
    }
    return res.json({
      success: true,
      message: "Wallet deducted. MPESA payout initiated.",
      payout: payoutResult
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// B2C result callback
app.post("/b2c/result", async (req, res) => {
  try {
    const result = req.body.Result;
    if (!result || !result.ResultParameters) {
      return res.status(400).send("Missing result data");
    }
    const params = result.ResultParameters.ResultParameter;
    const phoneParam = params.find(p => p.Key === "ReceiverPartyPublicName");
    const amountParam = params.find(p => p.Key === "TransactionAmount");
    if (!phoneParam || !amountParam) {
      return res.status(400).send("Missing necessary parameters");
    }
    const phoneNumber = phoneParam.Value.replace(/^tel:/, "");
    const callbackAmount = parseFloat(amountParam.Value);
    const resultCode = result.ResultCode;
    const transactionsRef = db.collection("wallet_transactions");
    const usersRef = db.collection("users");
    const snapshot = await transactionsRef
      .where("type", "==", "Withdraw")
      .where("status", "==", "pending")
      .where("phone", "==", phoneNumber)
      .get();
    if (snapshot.empty) {
      return res.status(200).send("No matching transaction found");
    }
    let processed = false;
    for (const doc of snapshot.docs) {
      const tx = doc.data();
      const txAmount = Math.abs(tx.amount);
      if (txAmount === callbackAmount) {
        const isSuccess = resultCode === 0;
        const userRef = usersRef.doc(tx.userId);
        await db.runTransaction(async (t) => {
          if (isSuccess) {
            t.update(doc.ref, {
              status: "completed",
              mpesaMeta: result,
            });
          } else {
            const userSnap = await t.get(userRef);
            const currentBalance = userSnap.data().walletBalance || 0;
            const refundAmount = Math.abs(tx.amount);
            t.update(userRef, {
              walletBalance: currentBalance + refundAmount,
            });
            t.update(doc.ref, {
              status: "failed",
              mpesaMeta: result,
            });
            const refundLogRef = db.collection("wallet_transactions").doc();
            t.set(refundLogRef, {
              userId: tx.userId,
              type: "Refund",
              amount: refundAmount,
              relatedTo: doc.id,
              phone: phoneNumber,
              timestamp: admin.firestore.FieldValue.serverTimestamp(),
              status: "completed",
              reason: "M-Pesa B2C failed",
            });
          }
        });
        processed = true;
        break;
      }
    }
    return res.status(200).send("B2C result processed");
  } catch (error) {
    return res.status(500).send("Internal server error");
  }
});

// Request completed endpoint
app.post("/request-completed", async (req, res) => {
  try {
    const { before, after, requestId } = req.body;
    if (
      before.status !== "completed" &&
      after.status === "completed" &&
      after.weight &&
      after.userId &&
      after.wasteType
    ) {
      const userId = after.userId;
      const weight = after.weight;
      const normalized = normalizeWasteType(after.wasteType);
      const processedDoc = await processedRequestsRef.doc(requestId).get();
      if (processedDoc.exists) {
        return res.status(200).json({ message: "Already processed" });
      }
      const priceSnap = await wastePricesRef.doc(normalized).get();
      if (!priceSnap.exists) {
        return res.status(400).json({ error: "Waste price not found" });
      }
      const pricePerKg = priceSnap.data().pricePerKg;
      const amount = weight * pricePerKg;
      const userRef = usersRef.doc(userId);
      await db.runTransaction(async (tx) => {
        const userSnap = await tx.get(userRef);
        if (!userSnap.exists) throw new Error("User not found");
        tx.update(userRef, {
          walletBalance: admin.firestore.FieldValue.increment(amount),
          recycledWeight: admin.firestore.FieldValue.increment(weight),
          pointsEarned: admin.firestore.FieldValue.increment(weight / 50),
          co2Saved: admin.firestore.FieldValue.increment(weight * 1.5),
        });
        tx.set(walletRef.doc(), {
          userId,
          type: "Recycle Credit",
          amount,
          wasteType: normalized,
          weight: weight,
          relatedRequest: requestId,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          status: "completed",
          details: `Credited for recycling ${weight}kg of ${normalized}`,
        });
        tx.set(processedRequestsRef.doc(requestId), {
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
      // Notify user about credit and admins about completion
      try {
        await sendToUserToken(userId, {
          title: "Recycling Completed",
          body: `Credited ${amount.toFixed(2)} for ${weight}kg of ${normalized}`,
        }, { route: "/wallet" });
        await sendToAdmins({
          title: "Request Completed",
          body: `User ${userId} credited ${amount.toFixed(2)} (${weight}kg ${normalized})`,
        }, { requestId });
      } catch (_) {}

      return res.json({ success: true });
    } else {
      return res.status(200).json({ message: "No update needed" });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

function normalizeWasteType(str) {
  if (!str || typeof str !== "string") return "";
  let formatted = str.trim().charAt(0).toUpperCase() + str.trim().slice(1).toLowerCase();
  if (!formatted.endsWith("s")) formatted += "s";
  return formatted;
}

// Utility endpoint to clean up expired OTPs (optional - run periodically)
app.post("/cleanup-expired-otps", async (req, res) => {
  try {
    const now = Date.now();
    const expiredQuery = await otpRef.where("expiresAt", "<", now).get();
    
    const batch = db.batch();
    expiredQuery.docs.forEach(doc => {
      batch.delete(doc.ref);
    });
    
    await batch.commit();
    console.log(`🧹 Cleaned up ${expiredQuery.size} expired OTPs`);
    
    return res.json({ success: true, cleaned: expiredQuery.size });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Export for serverless (e.g., Vercel) or start server when run directly
const PORT = process.env.PORT || 8080;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
} else {
  module.exports = app;
}