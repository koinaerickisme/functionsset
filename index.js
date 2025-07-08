const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const Africastalking = require("africastalking");

// ✅ Load Firebase credentials from env
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Africa’s Talking setup
const africastalking = Africastalking({
  apiKey: process.env.AT_API_KEY,       // Set this in Render
  username: process.env.AT_USERNAME,    // Usually 'sandbox'
});
const sms = africastalking.SMS;

// ✅ In-memory OTP store (use Firestore for production)
const otpStore = {};

// ✅ Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ✅ SEND OTP
app.post("/send-otp", async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ error: "Phone number required" });

  const otp = Math.floor(100000 + Math.random() * 900000); // 6-digit code
  const expiresAt = Date.now() + 5 * 60 * 1000; // expires in 5 minutes

  otpStore[phoneNumber] = { otp, expiresAt };

  try {
    const response = await sms.send({
      to: [phoneNumber],
      message: `Your verification code is ${otp}`,
      from: "AFRICASTKNG", // Use default or approved Sender ID
    });

    return res.json({ success: true, message: "OTP sent", response });
  } catch (error) {
    console.error("send-otp error:", error);
    return res.status(500).json({ error: "Failed to send OTP" });
  }
});

// ✅ VERIFY OTP
app.post("/verify-otp", (req, res) => {
  const { phoneNumber, otp } = req.body;

  const record = otpStore[phoneNumber];
  if (!record) return res.status(400).json({ error: "No OTP found for this number" });
  if (Date.now() > record.expiresAt) return res.status(400).json({ error: "OTP expired" });
  if (record.otp.toString() !== otp.toString()) return res.status(400).json({ error: "Invalid OTP" });

  delete otpStore[phoneNumber]; // Clear after verification
  return res.json({ success: true, message: "OTP verified" });
});

// ✅ POST /update-recycled-stats
app.post("/update-recycled-stats", async (req, res) => {
  try {
    const { before, after, requestId } = req.body;

    const userId = after?.userId || before?.userId;
    if (!userId) return res.status(400).json({ error: "No userId found" });

    const getCompletedWeight = (data) =>
      data && data.status === "completed" ? data.weight || 0 : 0;

    const beforeWeight = getCompletedWeight(before);
    const afterWeight = getCompletedWeight(after);
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
    console.error("update-recycled-stats error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ✅ POST /withdraw
app.post("/withdraw", async (req, res) => {
  const { userId, amount } = req.body;

  if (!userId || !amount || amount <= 0) {
    return res.status(400).json({ error: "Invalid data" });
  }

  const userRef = admin.firestore().collection("users").doc(userId);

  try {
    await admin.firestore().runTransaction(async (transaction) => {
      const userSnap = await transaction.get(userRef);
      const balance = userSnap.data().walletBalance || 0;

      if (amount > balance) {
        throw new Error("Insufficient balance");
      }

      transaction.update(userRef, {
        walletBalance: balance - amount,
      });

      transaction.set(
        admin.firestore().collection("wallet_transactions").doc(),
        {
          userId,
          type: "Withdraw",
          amount: -amount,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          status: "completed",
        }
      );
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("withdraw error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ✅ POST /request-completed
app.post("/request-completed", async (req, res) => {
  const { before, after, requestId } = req.body;

  if (
    before.status !== "completed" &&
    after.status === "completed" &&
    after.weight &&
    after.userId &&
    after.wasteType
  ) {
    try {
      const userId = after.userId;
      const weight = after.weight;
      const wasteType = after.wasteType;

      const priceSnap = await admin
        .firestore()
        .collection("waste_prices")
        .doc(wasteType)
        .get();

      const pricePerKg = priceSnap.exists
        ? priceSnap.data().pricePerKg || 0
        : 0;

      if (!pricePerKg) {
        console.warn(`No price found for waste type: ${wasteType}`);
        return res.status(400).json({ error: "Invalid price per kg" });
      }

      const amount = weight * pricePerKg;

      const userRef = admin.firestore().collection("users").doc(userId);
      await admin.firestore().runTransaction(async (transaction) => {
        transaction.update(userRef, {
          walletBalance: admin.firestore.FieldValue.increment(amount),
          recycledWeight: admin.firestore.FieldValue.increment(weight),
          pointsEarned: admin.firestore.FieldValue.increment(weight / 50),
          co2Saved: admin.firestore.FieldValue.increment(weight * 1.5),
        });
      });

      await admin.firestore().collection("wallet_transactions").add({
        userId,
        type: "Recycle Credit",
        amount: amount,
        relatedRequest: requestId,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        status: "completed",
        details: `Credited for recycling ${weight}kg of ${wasteType}`,
      });

      return res.json({ success: true });
    } catch (err) {
      console.error("request-completed error:", err);
      return res.status(500).json({ error: err.message });
    }
  } else {
    return res.status(200).json({ message: "No update needed." });
  }
});

// ✅ Start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
