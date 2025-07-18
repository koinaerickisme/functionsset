const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const Africastalking = require("africastalking");
const Joi = require("joi");

// 🔐 Load Firebase credentials safely
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
} catch (e) {
  console.error("❌ Invalid Firebase service account key:", e.message);
  process.exit(1);
}

// 🔐 Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// 🔁 Firestore references
const db = admin.firestore();
const usersRef = db.collection("users");
const otpRef = db.collection("otp_verifications");
const walletRef = db.collection("wallet_transactions");
const wastePricesRef = db.collection("waste_prices");
const processedRequestsRef = db.collection("processed_requests");

// 🌍 Africa's Talking setup
const africastalking = Africastalking({
  apiKey: process.env.AT_API_KEY,
  username: process.env.AT_USERNAME || "mementmori",
});
const sms = africastalking.SMS;

// 🚀 Express setup
const app = express();
app.use(cors());
app.use(express.json());

// ✅ Health check
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ✅ Send OTP
app.post("/send-otp", async (req, res) => {
  const schema = Joi.object({ phoneNumber: Joi.string().required() });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  const { phoneNumber } = value;
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

// ✅ Verify OTP
app.post("/verify-otp", async (req, res) => {
  const schema = Joi.object({
    phoneNumber: Joi.string().required(),
    otp: Joi.string().required(),
  });

  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  const { phoneNumber, otp } = value;

  try {
    const doc = await otpRef.doc(phoneNumber).get();
    if (!doc.exists) return res.status(400).json({ error: "No OTP found" });

    const data = doc.data();
    if (Date.now() > data.expiresAt) return res.status(400).json({ error: "OTP expired" });
    if (data.otp.toString() !== otp.toString()) return res.status(400).json({ error: "Invalid OTP" });

    await otpRef.doc(phoneNumber).delete();
    return res.json({ success: true, message: "OTP verified" });
  } catch (err) {
    console.error("❌ verify-otp error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ✅ Withdraw funds
app.post("/withdraw", async (req, res) => {
  const schema = Joi.object({
    userId: Joi.string().required(),
    amount: Joi.number().positive().required(),
  });

  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  const { userId, amount } = value;
  const userRef = usersRef.doc(userId);

  try {
    await db.runTransaction(async (transaction) => {
      const userSnap = await transaction.get(userRef);
      if (!userSnap.exists) throw new Error("User not found");

      const balance = userSnap.data().walletBalance || 0;
      if (amount > balance) throw new Error("Insufficient balance");

      transaction.update(userRef, {
        walletBalance: balance - amount,
      });

      transaction.set(walletRef.doc(), {
        userId,
        type: "Withdraw",
        amount: -amount,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        status: "completed",
      });
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("❌ withdraw error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// 🔤 Normalize waste type string
function normalizeWasteType(str) {
  if (!str || typeof str !== "string") return "";
  let formatted = str.trim().charAt(0).toUpperCase() + str.trim().slice(1).toLowerCase();
  // Ensure it ends with 's' for plural
  if (!formatted.endsWith('s')) {
    formatted += 's';
  }
  return formatted;
}

// ✅ Request completed & credit user
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
    const wasteType = after.wasteType;
    const normalizedWasteType = normalizeWasteType(wasteType);

    try {
      const processedDoc = await processedRequestsRef.doc(requestId).get();
      if (processedDoc.exists) {
        console.log("ℹ️ Already processed:", requestId);
        return res.status(200).json({ message: "Already processed" });
      }

      const priceDocSnap = await wastePricesRef.doc(normalizedWasteType).get();

      if (!priceDocSnap.exists) {
        return res.status(400).json({ error: `Waste price not found for type '${normalizedWasteType}'` });
      }

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
          details: `Credited for recycling ${weight}kg of ${normalizedWasteType}`,
        });

        transaction.set(processedRequestsRef.doc(requestId), {
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      return res.json({ success: true });
    } catch (err) {
      console.error("❌ request-completed error:", err);
      return res.status(500).json({ error: err.message });
    }
  } else {
    return res.status(200).json({ message: "No update needed." });
  }
});

// ✅ Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
