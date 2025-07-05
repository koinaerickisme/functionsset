const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

// Incremental update for recycled stats and admin notification
exports.updateRecycledStatsIncremental = functions.firestore
    .document("recycling_requests/{requestId}")
    .onWrite(async (change, context) => {
      const before = change.before.exists ? change.before.data() : null;
      const after = change.after.exists ? change.after.data() : null;

      const userId = after ? after.userId : before.userId;
      if (!userId) return null;

      const getCompletedWeight = (data) =>
      data && data.status === "completed" ? (data.weight || 0) : 0;

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

      if (!change.before.exists && after) {
        await admin.firestore().collection("admin_notifications").add({
          type: "new_pickup",
          requestId: context.params.requestId,
          userId: after.userId,
          wasteType: after.wasteType,
          scheduledDate: after.scheduledDate,
          location: after.location,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          read: false,
        });
      }

      return null;
    });

// Withdraw wallet function
exports.withdraw = functions.https.onCall(async (data, context) => {
  const userId = context.auth.uid;
  const amount = data.amount;

  if (!userId || !amount || amount <= 0) {
    throw new functions.https.HttpsError("invalid-argument", "Invalid data");
  }

  const userRef = admin.firestore().collection("users").doc(userId);

  return admin.firestore().runTransaction(async (transaction) => {
    const userSnap = await transaction.get(userRef);
    const balance = userSnap.data().walletBalance || 0;

    if (amount > balance) {
      throw new functions.https.HttpsError(
          "failed-precondition",
          "Insufficient balance",
      );
    }

    transaction.update(userRef, {walletBalance: balance - amount});

    transaction.set(admin.firestore().collection("wallet_transactions").doc(), {
      userId,
      type: "Withdraw",
      amount: -amount,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      status: "completed",
    });

    return {success: true};
  });
});

// On request completed: credit wallet and update stats
exports.onRequestCompleted = functions.firestore
    .document("recycling_requests/{requestId}")
    .onUpdate(async (change, context) => {
      const before = change.before.data();
      const after = change.after.data();

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

        const priceSnap = await admin
            .firestore()
            .collection("waste_prices")
            .doc(wasteType)
            .get();

        const pricePerKg = priceSnap.exists ?
        priceSnap.data().pricePerKg || 0 :
        0;

        if (!pricePerKg) {
          console.warn(`No price found for waste type: ${wasteType}`);
          return null;
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
          relatedRequest: context.params.requestId,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          status: "completed",
          details: `Credited for recycling ${weight}kg of ${wasteType}`,
        });
      }
      return null;
    });
