const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const Africastalking = require("africastalking");

// ✅ Load Firebase credentials safely
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
} catch (e) {
  console.error("❌ Invalid Firebase service account key:", e.message);
  process.exit(1);
}

// ✅ Initialize Firebase
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ✅ Initialize Express
const app = express();
app.use(cors());
app.use(express.json());

// ✅ Initialize Africa's Talking
const africastalking = Africastalking({
  apiKey: process.env.AT_API_KEY,
  username: process.env.AT_USERNAME || "mementmori",
});
const sms = africastalking.SMS;

// ✅ In-memory OTP store (replace with Redis or Firestore in production)
const otpStore = {};

// ✅ Health Check
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ✅ Send OTP
app.post("/send-otp", async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: "Phone number required" });

  const otp = Math.floor(100000 + Math.random() * 900000);
  otpStore[phoneNumber] = { otp, expiresAt: Date.now() + 5 * 60 * 1000 };

  try {
    const response = await sms.send({
      to: [phoneNumber],
      message: `Your verification code is ${otp}`,
      from: "AFRICASTKNG",
    });

    return res.json({ success: true, message: "OTP sent", response });
  } catch (error) {
    console.error("❌ Error sending OTP:", error);
    return res.status(500).json({ error: "Failed to send OTP" });
  }
});

// ✅ Verify OTP
app.post("/verify-otp", (req, res) => {
  const { phoneNumber, otp } = req.body;
  const record = otpStore[phoneNumber];

  if (!record) return res.status(400).json({ error: "No OTP found" });
  if (Date.now() > record.expiresAt) return res.status(400).json({ error: "OTP expired" });
  if (record.otp.toString() !== otp.toString()) return res.status(400).json({ error: "Invalid OTP" });

  delete otpStore[phoneNumber];
  return res.json({ success: true, message: "OTP verified" });
});

// ✅ Update recycled stats
app.post("/update-recycled-stats", async (req, res) => {
  try {
    const { before, after, requestId } = req.body;
    const userId = after?.userId || before?.userId;
    if (!userId) return res.status(400).json({ error: "No userId found" });

    const getWeight = (data) => (data?.status === "completed" ? data.weight || 0 : 0);
    const beforeWeight = getWeight(before);
    const afterWeight = getWeight(after);
    const diffWeight = afterWeight - beforeWeight;

    const diffPoints = diffWeight / 50;
    const diffCO2 = diffWeight * 1.5;

    const userRef = admin.firestore().collection("users").doc(userId);
    await userRef.update({
      recycledWeight: admin.firestore.FieldValue.increment(diffWeight),
      pointsEarned: admin.firestore.FieldValue.increment(diffPoints),
      co2Saved: admin.firestore.FieldValue.increment(diffCO2),
    });

    if (!before && after) {
      await admin.firestore().collection("admin_notifications").add({
        type: "new_pickup",
        requestId,
        userId: after.userId,
        wasteType: after.wasteType,
        scheduledDate: after.scheduledDate,
        location: after.location,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        read: false,
      });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("❌ update-recycled-stats error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ✅ Withdraw endpoint
app.post("/withdraw", async (req, res) => {
  const { userId, amount } = req.body;
  if (!userId || !amount || amount <= 0) {
    return res.status(400).json({ error: "Invalid data" });
  }

  const userRef = admin.firestore().collection("users").doc(userId);

  try {
    await admin.firestore().runTransaction(async (transaction) => {
      const userSnap = await transaction.get(userRef);
      const balance = userSnap.data()?.walletBalance || 0;

      if (amount > balance) throw new Error("Insufficient balance");

      transaction.update(userRef, {
        walletBalance: balance - amount,
      });

      transaction.set(admin.firestore().collection("wallet_transactions").doc(), {
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

// ✅ Mark request as completed
app.post("/request-completed", async (req, res) => {
  const { before, after, requestId } = req.body;
  console.log("request-completed called", { before, after, requestId });

  if (
    before.status !== "completed" &&
    after.status === "completed" &&
    after.weight &&
    after.userId &&
    after.wasteType
  ) {
    try {
      const { userId, weight, wasteType } = after;
      console.log("Processing for wasteType:", wasteType);

      // Try exact → lowercase → uppercase
      const variants = [wasteType, wasteType.toLowerCase(), wasteType.toUpperCase()];
      let priceSnap = null;

      for (const key of variants) {
        const snap = await admin.firestore().collection("waste_prices").doc(key).get();
        if (snap.exists) {
          priceSnap = snap;
          console.log(`Found price doc for wasteType: ${key}`);
          break;
        }
      }

      if (!priceSnap) {
        console.error("❌ No price found for any casing variant.");
        return res.status(400).json({ error: "Invalid waste type for pricing" });
      }

      const pricePerKg = priceSnap.data().pricePerKg || 0;
      const amount = weight * pricePerKg;

      const userRef = admin.firestore().collection("users").doc(userId);
      await admin.firestore().runTransaction(async (transaction) => {
        const userSnap = await transaction.get(userRef);
        if (!userSnap.exists) throw new Error("User not found");

        transaction.update(userRef, {
          walletBalance: admin.firestore.FieldValue.increment(amount),
          recycledWeight: admin.firestore.FieldValue.increment(weight),
          pointsEarned: admin.firestore.FieldValue.increment(weight / 50),
          co2Saved: admin.firestore.FieldValue.increment(weight * 1.5),
        });

        transaction.set(admin.firestore().collection("wallet_transactions").doc(), {
          userId,
          type: "Recycle Credit",
          amount,
          relatedRequest: requestId,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          status: "completed",
          details: `Credited for recycling ${weight}kg of ${wasteType}`,
        });
      });

      console.log("✅ Transaction completed for user:", userId);
      return res.json({ success: true });
    } catch (err) {
      console.error("❌ request-completed error:", err);
      return res.status(500).json({ error: err.message });
    }
  } else {
    console.log("ℹ️ No update needed for request-completed.");
    return res.status(200).json({ message: "No update needed." });
  }
});

// ✅ Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
