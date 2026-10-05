package com.webrtcmobile

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import com.facebook.react.ReactApplication
import com.facebook.react.modules.core.DeviceEventManagerModule

class CallForegroundService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == "END_CALL") {
      val app = application as ReactApplication
      app.reactNativeHost.reactInstanceManager.currentReactContext
        ?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        ?.emit("NativeCallEnded", null)
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
      return START_NOT_STICKY
    }
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(NotificationChannel("webrtc_call", "Video calls", NotificationManager.IMPORTANCE_LOW))
    }
    val open = PendingIntent.getActivity(this, 10, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val end = PendingIntent.getService(this, 11, Intent(this, CallForegroundService::class.java).setAction("END_CALL"), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, "webrtc_call") else Notification.Builder(this)
    val notification = builder.setContentTitle("WebRTC call in progress")
      .setContentText("Tap to return to your call")
      .setSmallIcon(android.R.drawable.presence_video_online)
      .setContentIntent(open).setOngoing(true)
      .addAction(Notification.Action.Builder(null, "End call", end).build())
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
      if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
      startForeground(8101, notification, types)
    } else startForeground(8101, notification)
    return START_NOT_STICKY
  }
  override fun onTaskRemoved(rootIntent: Intent?) { stopSelf(); super.onTaskRemoved(rootIntent) }
}
