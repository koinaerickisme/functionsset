const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const Africastalking = require("africastalking");
const { z } = require("zod");

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
} catch (e) {
  console.error("Invalid Firebase service account key:", e.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

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

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.post("/send-otp", async (req, res) => {
  const schema = z.object({ phoneNumber: z.string().min(1) });
  const validation = schema.safeParse(req.body);
  if (!validation.success) return res.status(400).json({ error: validation.error.errors[0].message });

  const { phoneNumber } = validation.data;
  const otp = Math.floor(100000 + Math.random() * 900000);
  const expiresAt = Date.now() + 5 * 60 * 1000;

  try {
    await otpRef.doc(phoneNumber).set({ otp, expiresAt });
    const response = await sms.send({ to: [phoneNumber], message: `Your verification code is ${otp}`, from: "AFRICASTKNG" });
    return res.json({ success: true, message: "OTP sent", response });
  } catch (err) {
    return res.status(500).json({ error: "Failed to send OTP" });
  }
});

app.post("/verify-otp", async (req, res) => {
  const schema = z.object({ phoneNumber: z.string().min(1), otp: z.string().min(1) });
  const validation = schema.safeParse(req.body);
  if (!validation.success) return res.status(400).json({ error: validation.error.errors[0].message });

  const { phoneNumber, otp } = validation.data;

  try {
    const doc = await otpRef.doc(phoneNumber).get();
    if (!doc.exists) return res.status(400).json({ error: "No OTP found" });
    const data = doc.data();
    if (Date.now() > data.expiresAt) return res.status(400).json({ error: "OTP expired" });
    if (data.otp.toString() !== otp.toString()) return res.status(400).json({ error: "Invalid OTP" });
    await otpRef.doc(phoneNumber).delete();
    return res.json({ success: true, message: "OTP verified" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/withdraw", async (req, res) => {
  const schema = z.object({ userId: z.string().min(1), amount: z.number().positive() });
  const validation = schema.safeParse(req.body);
  if (!validation.success) return res.status(400).json({ error: validation.error.errors[0].message });

  const { userId, amount } = validation.data;
  const userRef = usersRef.doc(userId);

  try {
    await db.runTransaction(async (transaction) => {
      const userSnap = await transaction.get(userRef);
      if (!userSnap.exists) throw new Error("User not found");
      const balance = userSnap.data().walletBalance || 0;
      if (amount > balance) throw new Error("Insufficient balance");
      transaction.update(userRef, { walletBalance: balance - amount });
      transaction.set(walletRef.doc(), { userId, type: "Withdraw", amount: -amount, timestamp: admin.firestore.FieldValue.serverTimestamp(), status: "completed" });
    });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/b2c", async (req, res) => {
  const schema = z.object({ user_id: z.string().min(1), phone: z.string().min(10), amount: z.number().positive() });
  const validation = schema.safeParse(req.body);
  if (!validation.success) return res.status(400).json({ error: validation.error.errors[0].message });

  const { user_id, phone, amount } = validation.data;
  const userRef = usersRef.doc(user_id);

  try {
    await db.runTransaction(async (transaction) => {
      const userSnap = await transaction.get(userRef);
      if (!userSnap.exists) throw new Error("User not found");
      const balance = userSnap.data().walletBalance || 0;
      if (amount > balance) throw new Error("Insufficient balance");
      transaction.update(userRef, { walletBalance: balance - amount });
      transaction.set(walletRef.doc(), { userId: user_id, type: "Withdraw", amount: -amount, timestamp: admin.firestore.FieldValue.serverTimestamp(), status: "completed", method: "B2C", phone });
    });
    return res.json({ success: true, message: "Withdrawal processed and wallet updated." });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/b2c/result", async (req, res) => {
  console.log("B2C Result Callback:", req.body);
  res.status(200).send("OK");
});

function normalizeWasteType(str) {
  if (!str || typeof str !== "string") return "";
  let formatted = str.trim().charAt(0).toUpperCase() + str.trim().slice(1).toLowerCase();
  if (!formatted.endsWith('s')) formatted += 's';
  return formatted;
}

app.post("/request-completed", async (req, res) => {
  const { before, after, requestId } = req.body;
  if (before.status !== "completed" && after.status === "completed" && after.weight && after.userId && after.wasteType) {
    const userId = after.userId;
    const weight = after.weight;
    const wasteType = normalizeWasteType(after.wasteType);

    try {
      const processedDoc = await processedRequestsRef.doc(requestId).get();
      if (processedDoc.exists) return res.status(200).json({ message: "Already processed" });

      const priceDocSnap = await wastePricesRef.doc(wasteType).get();
      if (!priceDocSnap.exists) return res.status(400).json({ error: `Waste price not found for type '${wasteType}'` });

      const pricePerKg = priceDocSnap.data().pricePerKg || 0;
      const amount = weight * pricePerKg;

      const userRef = usersRef.doc(userId);
      await db.runTransaction(async (transaction) => {
        const userSnap = await transaction.get(userRef);
        if (!userSnap.exists) throw new Error("User not found");

        transaction.update(userRef, {
          walletBalance: admin.firestore.FieldValue.increment(amount),
          recycledWeight: admin.firestore.FieldValue.increment(weight),
          pointsEarned: admin.firestore.FieldValue.increment(weight / 50),
          co2Saved: admin.firestore.FieldValue.increment(weight * 1.5),
        });

        transaction.set(walletRef.doc(), {
          userId,
          type: "Recycle Credit",
          amount,
          relatedRequest: requestId,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          status: "completed",
          details: `Credited for recycling ${weight}kg of ${wasteType}`,
        });

        transaction.set(processedRequestsRef.doc(requestId), { processedAt: admin.firestore.FieldValue.serverTimestamp() });
      });
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  } else {
    return res.status(200).json({ message: "No update needed." });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
