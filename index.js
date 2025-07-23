const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const { z } = require("zod");
const fetch = require("node-fetch"); // For calling Python payout service
const {smsService} = require("./sms");

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

app.use((err, req, res, next) => {
  console.error("🔥 Server Error:", err.stack);
  res.status(500).json({ error: "Internal server error" });
});

// OTP endpoints
app.post("/send-otp", async (req, res) => {
  try {
    const schema = z.object({ phoneNumber: z.string().min(10) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }
    const { phoneNumber } = parsed.data;
    const otp = Math.floor(100000 + Math.random() * 900000);
    const expiresAt = Date.now() + 5 * 60 * 1000;
    await otpRef.doc(phoneNumber).set({ otp, expiresAt });
    const response = await smsService.sendSms(phoneNumber, `Your verification code is ${otp}`);
    return res.json({ success: true, message: "OTP sent", response });
  } catch (err) {
    return res.status(500).json({ error: "Failed to send OTP", details: err.message });
  }
});

app.post("/verify-otp", async (req, res) => {
  try {
    const schema = z.object({
      phoneNumber: z.string(),
      otp: z.string(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });
    const { phoneNumber, otp } = parsed.data;
    const doc = await otpRef.doc(phoneNumber).get();
    if (!doc.exists) return res.status(400).json({ error: "No OTP found" });
    const data = doc.data();
    if (Date.now() > data.expiresAt) return res.status(400).json({ error: "OTP expired" });
    if (data.otp.toString() !== otp.toString()) return res.status(400).json({ error: "Invalid OTP" });
    await otpRef.doc(phoneNumber).delete();
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
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
        phone,
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
          phone,
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
          relatedRequest: requestId,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          status: "completed",
          details: `Credited for recycling ${weight}kg of ${normalized}`,
        });
        tx.set(processedRequestsRef.doc(requestId), {
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
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

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});