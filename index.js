const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const Africastalking = require("africastalking");
const { z } = require("zod");

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
const otpRef = db.collection("otp_verifications");
const walletRef = db.collection("wallet_transactions");
const wastePricesRef = db.collection("waste_prices");
const processedRequestsRef = db.collection("processed_requests");

const africastalking = Africastalking({
  apiKey: process.env.AT_API_KEY,
  username: process.env.AT_USERNAME || "mementmori",
});
const sms = africastalking.SMS;

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_, res) => res.json({ status: "ok" }));

// Add error logging middleware
app.use((err, req, res, next) => {
  console.error("🔥 Server Error:", err.stack);
  res.status(500).json({ error: "Internal server error" });
});

// Enhanced OTP endpoint with better logging
app.post("/send-otp", async (req, res) => {
  try {
    const schema = z.object({ phoneNumber: z.string().min(10) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      console.log("Invalid OTP request payload:", req.body);
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const { phoneNumber } = parsed.data;
    const otp = Math.floor(100000 + Math.random() * 900000);
    const expiresAt = Date.now() + 5 * 60 * 1000;

    console.log(`🔑 Generating OTP ${otp} for ${phoneNumber}`);

    await otpRef.doc(phoneNumber).set({ otp, expiresAt });
    const response = await sms.send({
      to: [phoneNumber],
      message: `Your verification code is ${otp}`,
      from: "AFRICASTKNG",
    });
    
    console.log(`📲 OTP sent to ${phoneNumber}`);
    return res.json({ success: true, message: "OTP sent", response });
  } catch (err) {
    console.error("❌ Failed to send OTP:", err);
    return res.status(500).json({ error: "Failed to send OTP", details: err.message });
  }
});

// Enhanced verify-otp endpoint
app.post("/verify-otp", async (req, res) => {
  try {
    const schema = z.object({
      phoneNumber: z.string(),
      otp: z.string(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });

    const { phoneNumber, otp } = parsed.data;
    console.log(`🔍 Verifying OTP for ${phoneNumber}`);

    const doc = await otpRef.doc(phoneNumber).get();
    if (!doc.exists) {
      console.log("No OTP record found for", phoneNumber);
      return res.status(400).json({ error: "No OTP found" });
    }

    const data = doc.data();
    if (Date.now() > data.expiresAt) {
      console.log("Expired OTP for", phoneNumber);
      return res.status(400).json({ error: "OTP expired" });
    }

    if (data.otp.toString() !== otp.toString()) {
      console.log(`Mismatched OTP for ${phoneNumber} (expected: ${data.otp}, received: ${otp})`);
      return res.status(400).json({ error: "Invalid OTP" });
    }

    await otpRef.doc(phoneNumber).delete();
    console.log(`✅ Verified OTP for ${phoneNumber}`);
    return res.json({ success: true });
  } catch (err) {
    console.error("❌ OTP verification error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Enhanced withdraw endpoint with detailed transaction logging
app.post("/withdraw", async (req, res) => {
  try {
    const schema = z.object({
      userId: z.string(),
      amount: z.number().positive(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      console.log("Invalid withdraw payload:", req.body);
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const { userId, amount } = parsed.data;
    const userRef = usersRef.doc(userId);

    console.log(`💸 Starting withdrawal of ${amount} for user ${userId}`);
    
    await db.runTransaction(async (tx) => {
      console.log(`🔍 Fetching user ${userId} data`);
      const userDoc = await tx.get(userRef);
      
      if (!userDoc.exists) {
        console.log(`User ${userId} not found`);
        throw new Error("User not found");
      }

      const balance = userDoc.data().walletBalance || 0;
      console.log(`💰 Current balance: ${balance}, Withdrawal amount: ${amount}`);

      if (amount > balance) {
        console.log(`Insufficient balance for user ${userId} (${balance} available)`);
        throw new Error("Insufficient balance");
      }

      const newBalance = balance - amount;
      console.log(`🔄 Updating balance to ${newBalance}`);
      
      tx.update(userRef, { walletBalance: newBalance });
      tx.set(walletRef.doc(), {
        userId,
        type: "Withdraw",
        amount: -amount,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        status: "completed",
      });
    });

    console.log(`✅ Successfully withdrew ${amount} from user ${userId}`);
    return res.json({ success: true });
  } catch (err) {
    console.error("❌ Withdrawal failed:", err);
    return res.status(500).json({ 
      error: err.message,
      details: `Failed to process withdrawal for user ${req.body?.userId || 'unknown'}`
    });
  }
});

// Enhanced B2C endpoint with transaction verification
app.post("/b2c", async (req, res) => {
  try {
    const schema = z.object({
      user_id: z.string(),
      phone: z.string().min(10),
      amount: z.number().positive(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      console.log("Invalid B2C payload:", req.body);
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const { user_id, phone, amount } = parsed.data;
    const userRef = usersRef.doc(user_id);

    console.log(`💳 Starting B2C transaction of ${amount} for user ${user_id}`);

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        console.log(`User ${user_id} not found for B2C`);
        throw new Error("User not found");
      }

      const balance = userSnap.data().walletBalance || 0;
      console.log(`💰 Current balance: ${balance}, B2C amount: ${amount}`);

      if (amount > balance) {
        console.log(`Insufficient balance for B2C (${balance} available)`);
        throw new Error("Insufficient balance");
      }

      const newBalance = balance - amount;
      console.log(`🔄 Updating balance to ${newBalance}`);

      tx.update(userRef, { walletBalance: newBalance });
      tx.set(walletRef.doc(), {
        userId: user_id,
        type: "Withdraw",
        amount: -amount,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        status: "pending",
        method: "B2C",
        phone,
      });
    });

    console.log(`⏳ B2C transaction initiated for user ${user_id}. Awaiting MPESA callback.`);
    return res.json({ success: true, message: "Wallet deducted. Awaiting MPESA callback." });
  } catch (err) {
    console.error("❌ B2C transaction failed:", err);
    return res.status(500).json({ 
      error: err.message,
      details: `Failed to process B2C for user ${req.body?.user_id || 'unknown'}`
    });
  }
});

app.post("/b2c/result", async (req, res) => {
  try {
    const data = req.body;
    console.log("📩 B2C Callback Received:", JSON.stringify(data, null, 2));

    await db.collection("b2c_results").add({
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      result: data,
    });

    const result = data.mpesa_response;
    if (result && result.OriginatorConversationID) {
      console.log(`🔍 Processing B2C callback for transaction ${result.OriginatorConversationID}`);

      const transactions = await walletRef
        .where("status", "==", "pending")
        .where("method", "==", "B2C")
        .get();

      let processed = false;
      transactions.forEach(async (doc) => {
        const tx = doc.data();
        const txAmount = Number(tx.amount);
        const callbackAmount = -Math.abs(Number(data.amount));
        
        console.log(`🔎 Comparing transaction ${doc.id}:`, {
          txUserId: tx.userId,
          reqUserId: data.user_id,
          txAmount,
          callbackAmount
        });

        if (tx.userId === data.user_id && txAmount === callbackAmount) {
          console.log(`✅ Matching transaction found: ${doc.id}`);
          await doc.ref.update({
            status: "completed",
            mpesaMeta: result,
          });
          processed = true;
        }
      });

      if (!processed) {
        console.log("⚠️ No matching transaction found for callback");
      }
    } else {
      console.log("❗ Callback missing required MPESA response data");
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ B2C callback processing failed:", err);
    res.status(500).send("Failed to process");
  }
});

// Enhanced request-completed handler
app.post("/request-completed", async (req, res) => {
  try {
    const { before, after, requestId } = req.body;
    console.log(`🔄 Processing request completion for ${requestId}`);

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

      console.log(`♻️ Processing completed recycling request:`, {
        user: userId,
        weight,
        wasteType: normalized,
        requestId
      });

      const processedDoc = await processedRequestsRef.doc(requestId).get();
      if (processedDoc.exists) {
        console.log(`✅ Request ${requestId} already processed`);
        return res.status(200).json({ message: "Already processed" });
      }

      const priceSnap = await wastePricesRef.doc(normalized).get();
      if (!priceSnap.exists) {
        console.log(`❌ No price found for waste type: ${normalized}`);
        return res.status(400).json({ error: "Waste price not found" });
      }

      const pricePerKg = priceSnap.data().pricePerKg;
      const amount = weight * pricePerKg;

      console.log(`💰 Calculating credit: ${weight}kg x ${pricePerKg} = ${amount}`);

      const userRef = usersRef.doc(userId);
      await db.runTransaction(async (tx) => {
        const userSnap = await tx.get(userRef);
        if (!userSnap.exists) {
          console.log(`❌ User ${userId} not found during credit processing`);
          throw new Error("User not found");
        }

        const currentBalance = userSnap.data().walletBalance || 0;
        console.log(`💳 Current user balance: ${currentBalance}, adding ${amount}`);

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
          relatedRequest: requestId,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          status: "completed",
          details: `Credited for recycling ${weight}kg of ${normalized}`,
        });

        tx.set(processedRequestsRef.doc(requestId), {
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      console.log(`✅ Successfully processed request ${requestId}`);
      return res.json({ success: true });
    } else {
      console.log("ℹ️ No update needed for request");
      return res.status(200).json({ message: "No update needed" });
    }
  } catch (err) {
    console.error("❌ Request completion processing failed:", err);
    return res.status(500).json({ error: err.message });
  }
});

function normalizeWasteType(str) {
  if (!str || typeof str !== "string") return "";
  let formatted = str.trim().charAt(0).toUpperCase() + str.trim().slice(1).toLowerCase();
  if (!formatted.endsWith("s")) formatted += "s";
  return formatted;
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
