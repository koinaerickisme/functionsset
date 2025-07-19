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

app.post("/send-otp", async (req, res) => {
  const schema = z.object({ phoneNumber: z.string().min(10) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });

  const { phoneNumber } = parsed.data;
  const otp = Math.floor(100000 + Math.random() * 900000);
  const expiresAt = Date.now() + 5 * 60 * 1000;

  try {
    await otpRef.doc(phoneNumber).set({ otp, expiresAt });
    const response = await sms.send({
      to: [phoneNumber],
      message: `Your verification code is ${otp}`,
      from: "AFRICASTKNG",
    });
    return res.json({ success: true, message: "OTP sent", response });
  } catch (err) {
    console.error("❌ send-otp error:", err);
    return res.status(500).json({ error: "Failed to send OTP" });
  }
});

app.post("/verify-otp", async (req, res) => {
  const schema = z.object({
    phoneNumber: z.string(),
    otp: z.string(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });

  const { phoneNumber, otp } = parsed.data;
  try {
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

app.post("/withdraw", async (req, res) => {
  const schema = z.object({
    userId: z.string(),
    amount: z.number().positive(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });

  const { userId, amount } = parsed.data;
  const userRef = usersRef.doc(userId);

  try {
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

app.post("/b2c", async (req, res) => {
  const schema = z.object({
    user_id: z.string(),
    phone: z.string().min(10),
    amount: z.number().positive(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });

  const { user_id, phone, amount } = parsed.data;
  const userRef = usersRef.doc(user_id);

  try {
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

    return res.json({ success: true, message: "Wallet deducted. Awaiting MPESA callback." });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/b2c/result", async (req, res) => {
  try {
    const data = req.body;
    console.log("📩 B2C Callback:", JSON.stringify(data, null, 2));

    await db.collection("b2c_results").add({
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      result: data,
    });

    const result = data.mpesa_response;
    if (result && result.OriginatorConversationID) {
      const transactions = await walletRef
        .where("status", "==", "pending")
        .where("method", "==", "B2C")
        .get();

      transactions.forEach(async (doc) => {
        const tx = doc.data();
        if (
          tx.userId === data.user_id &&
          tx.amount === -Math.abs(data.amount)
        ) {
          await doc.ref.update({
            status: "completed",
            mpesaMeta: result,
          });
        }
      });
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ B2C callback error:", err);
    res.status(500).send("Failed to process");
  }
});

function normalizeWasteType(str) {
  if (!str || typeof str !== "string") return "";
  let formatted = str.trim().charAt(0).toUpperCase() + str.trim().slice(1).toLowerCase();
  if (!formatted.endsWith("s")) formatted += "s";
  return formatted;
}

app.post("/request-completed", async (req, res) => {
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

    try {
      const processedDoc = await processedRequestsRef.doc(requestId).get();
      if (processedDoc.exists) return res.status(200).json({ message: "Already processed" });

      const priceSnap = await wastePricesRef.doc(normalized).get();
      if (!priceSnap.exists) return res.status(400).json({ error: "Waste price not found" });

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
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else {
    return res.status(200).json({ message: "No update needed" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
