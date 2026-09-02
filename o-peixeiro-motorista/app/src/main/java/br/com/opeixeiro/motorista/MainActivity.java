package br.com.opeixeiro.motorista;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.util.Log;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.appcompat.app.AlertDialog;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import com.google.android.material.button.MaterialButton;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.face.Face;
import com.google.mlkit.vision.face.FaceDetection;
import com.google.mlkit.vision.face.FaceDetector;
import com.google.mlkit.vision.face.FaceDetectorOptions;
import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.io.File;
import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;

public class MainActivity extends AppCompatActivity {
    private LinearLayout content;
    private String motoristaNome = "";
    private String pedidoId = "";
    private String pedidoQR = "";
    private String pedidoUnit = "";
    private List<PedidoItem> pedidoItems = new ArrayList<>();
    private Map<String, PedidoItem> itemsMap = new HashMap<>();
    private SupabaseClient supabaseClient;
    private android.content.SharedPreferences prefs;
    private WebView webView;
    private String webScannerMode;
    private ImageCapture selfieCapture;
    private boolean selfieCaptureInProgress = false;
    private boolean selfieSessionVerified = false;
    private TextView selfieStatus;
    private String emergencyProductOrderId;
    private String emergencyProductDriver;
    private String internalPurchaseId;
    private String internalPurchaseOrderId;
    private String internalPurchaseDriver;
    private String internalPurchaseSummary;
    private String internalPurchaseImageBase64;

    // As versões publicadas neste repositório aparecem na tela obrigatória de atualização.
    private static final String GITHUB_REPO = "fabiodkk/opeixeiropedidos";
    private static final String GITHUB_RELEASE_URL = "https://github.com/" + GITHUB_REPO + "/releases/latest";
    private static final int PERMISSION_CAMERA = 1001;
    private static final int PERMISSION_SELFIE_CAMERA = 1002;
    private static final int REQUEST_EMERGENCY_PRODUCT_PHOTO = 1003;
    private static final int PERMISSION_NOTIFICATIONS = 1004;
    private static final int REQUEST_INTERNAL_PURCHASE_RECEIPT = 1005;
    private static final int PERMISSION_INTERNAL_PURCHASE_CAMERA = 1006;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("opeixeiro_motorista", MODE_PRIVATE);
        supabaseClient = new SupabaseClient(this);
        scheduleEmergencyChecks();
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, PERMISSION_NOTIFICATIONS);
        }
        showSelfieConsent();
    }

    /**
     * Consulta diretamente o Supabase. Não usa Firebase nem qualquer conta Google.
     * O Android permite trabalhos periódicos com intervalo mínimo de 15 minutos;
     * também há uma consulta imediata a cada abertura do app.
     */
    private void scheduleEmergencyChecks() {
        Constraints internetRequired = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
        PeriodicWorkRequest periodic = new PeriodicWorkRequest.Builder(EmergencyOrderWorker.class, 15, TimeUnit.MINUTES)
                .setConstraints(internetRequired)
                .build();
        WorkManager manager = WorkManager.getInstance(this);
        manager.enqueueUniquePeriodicWork("opeixeiro_emergency_orders", ExistingPeriodicWorkPolicy.UPDATE, periodic);
        manager.enqueue(new OneTimeWorkRequest.Builder(EmergencyOrderWorker.class)
                .setConstraints(internetRequired)
                .build());
    }

    private void showSelfieConsent() {
        new AlertDialog.Builder(this)
                .setTitle("Verificação e auditoria")
                .setMessage("Uma selfie será capturada para liberar esta sessão. Em coletas emergenciais criadas após 09:00, a selfie e a foto obrigatória dos produtos serão enviadas ao grupo de logística para auditoria.")
                .setCancelable(false)
                .setNegativeButton("Sair", (dialog, which) -> finishAffinity())
                .setPositiveButton("Entendi e aceito", (dialog, which) -> showSelfieVerification())
                .show();
    }

    private void showSelfieVerification() {
        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{android.Manifest.permission.CAMERA}, PERMISSION_SELFIE_CAMERA);
            return;
        }
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(28), dp(20), dp(24));
        root.setBackgroundColor(Color.parseColor("#07131B"));
        TextView title = labelDark("Verificação de presença", 25f, Color.WHITE);
        root.addView(title);
        root.addView(labelDark("Centralize seu rosto. A selfie será tirada automaticamente quando um único rosto estiver nítido.", 14f, Color.parseColor("#BFD2D6")));
        PreviewView preview = new PreviewView(this);
        preview.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE);
        LinearLayout.LayoutParams previewParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f);
        previewParams.setMargins(0, dp(16), 0, dp(12));
        preview.setLayoutParams(previewParams);
        root.addView(preview);
        selfieStatus = labelDark("Iniciando câmera frontal…", 15f, Color.parseColor("#7BD7D4"));
        selfieStatus.setGravity(Gravity.CENTER);
        root.addView(selfieStatus);
        setContentView(root);
        startSelfieCamera(preview);
    }

    private void startSelfieCamera(PreviewView previewView) {
        ListenableFuture<ProcessCameraProvider> cameraProviderFuture = ProcessCameraProvider.getInstance(this);
        cameraProviderFuture.addListener(() -> {
            try {
                ProcessCameraProvider provider = cameraProviderFuture.get();
                Preview preview = new Preview.Builder().build();
                preview.setSurfaceProvider(previewView.getSurfaceProvider());
                selfieCapture = new ImageCapture.Builder().setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY).build();
                FaceDetectorOptions options = new FaceDetectorOptions.Builder()
                        .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
                        .build();
                FaceDetector detector = FaceDetection.getClient(options);
                ImageAnalysis analysis = new ImageAnalysis.Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build();
                analysis.setAnalyzer(ContextCompat.getMainExecutor(this), imageProxy -> analyzeSelfieFrame(detector, imageProxy));
                provider.unbindAll();
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_FRONT_CAMERA, preview, analysis, selfieCapture);
                selfieStatus.setText("Olhe para a câmera…");
            } catch (ExecutionException | InterruptedException error) {
                selfieStatus.setText("Não foi possível iniciar a verificação. Abra novamente o app.");
            }
        }, ContextCompat.getMainExecutor(this));
    }

    private void analyzeSelfieFrame(FaceDetector detector, ImageProxy proxy) {
        if (selfieCaptureInProgress) { proxy.close(); return; }
        if (proxy.getImage() == null) { proxy.close(); return; }
        InputImage image = InputImage.fromMediaImage(proxy.getImage(), proxy.getImageInfo().getRotationDegrees());
        detector.process(image).addOnSuccessListener(faces -> {
            if (faces.size() == 1) {
                Face face = faces.get(0);
                float width = face.getBoundingBox().width();
                if (width >= 180f) captureSelfie();
                else selfieStatus.setText("Aproxime um pouco o rosto.");
            } else if (faces.isEmpty()) {
                selfieStatus.setText("Centralize seu rosto na câmera.");
            } else {
                selfieStatus.setText("Deixe somente uma pessoa na câmera.");
            }
        }).addOnFailureListener(error -> selfieStatus.setText("Preparando a verificação facial… mantenha a internet ligada."))
          .addOnCompleteListener(task -> proxy.close());
    }

    private void captureSelfie() {
        if (selfieCaptureInProgress || selfieCapture == null) return;
        selfieCaptureInProgress = true;
        selfieStatus.setText("Rosto identificado. Salvando selfie…");
        File folder = new File(getFilesDir(), "audit-selfies");
        if (!folder.exists()) folder.mkdirs();
        File output = new File(folder, "selfie_" + System.currentTimeMillis() + ".jpg");
        ImageCapture.OutputFileOptions options = new ImageCapture.OutputFileOptions.Builder(output).build();
        selfieCapture.takePicture(options, ContextCompat.getMainExecutor(this), new ImageCapture.OnImageSavedCallback() {
            @Override public void onImageSaved(ImageCapture.OutputFileResults results) {
                selfieSessionVerified = true;
                prefs.edit().putString("last_selfie_path", output.getAbsolutePath()).putLong("last_selfie_at", System.currentTimeMillis()).apply();
                selfieStatus.setText("Verificação concluída.");
                new android.os.Handler().postDelayed(() -> showWebApp(), 550);
            }
            @Override public void onError(ImageCaptureException error) {
                selfieCaptureInProgress = false;
                selfieStatus.setText("Não foi possível salvar a selfie. Tente novamente.");
            }
        });
    }

    @SuppressWarnings("SetJavaScriptEnabled")
    private void showWebApp() {
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                Uri uri = Uri.parse(url);
                if ("opeixeiro".equals(uri.getScheme()) && "scan".equals(uri.getHost())) {
                    String mode = uri.getQueryParameter("mode");
                    startNativeScannerFromWeb("delivery".equals(mode) ? "delivery" : "pickup");
                    return true;
                }
                return false;
            }
        });
        webView.addJavascriptInterface(new AndroidScannerBridge(), "AndroidScanner");
        setContentView(webView);
        webView.loadUrl("file:///android_asset/indexmotorista.html");
        checkForUpdate();
    }

    private class AndroidScannerBridge {
        @JavascriptInterface public void startScan(String mode) {
            runOnUiThread(() -> startNativeScannerFromWeb(mode));
        }
        @JavascriptInterface public boolean isSelfieVerified() { return selfieSessionVerified; }
        @JavascriptInterface public void bindCreatedProfile(String name) { bindAuditProfile(name); }
        @JavascriptInterface public void reportEmergencyPickup(String orderId, String name) { postEmergencyAudit("emergency_pickup", orderId, name, null); }
        @JavascriptInterface public void captureEmergencyProductPhoto(String orderId, String name) {
            runOnUiThread(() -> {
                emergencyProductOrderId = orderId; emergencyProductDriver = name;
                Intent intent = new Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE);
                startActivityForResult(intent, REQUEST_EMERGENCY_PRODUCT_PHOTO);
            });
        }
        @JavascriptInterface public void captureInternalPurchaseReceipt(String purchaseId, String orderId, String name, String summary) {
            runOnUiThread(() -> {
                internalPurchaseId = purchaseId; internalPurchaseOrderId = orderId; internalPurchaseDriver = name; internalPurchaseSummary = summary; internalPurchaseImageBase64 = null;
                launchInternalPurchaseCamera();
            });
        }
        @JavascriptInterface public void saveInternalPurchaseReceipt() {
            if (internalPurchaseImageBase64 == null || internalPurchaseImageBase64.isEmpty()) {
                if (webView != null) webView.post(() -> webView.evaluateJavascript("window.onInternalPurchaseReceipt && window.onInternalPurchaseReceipt(false,'Tire a foto da nota fiscal antes de salvar.');", null));
                return;
            }
            postInternalPurchaseReceipt(internalPurchaseImageBase64);
        }
    }

    private void launchInternalPurchaseCamera() {
        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{android.Manifest.permission.CAMERA}, PERMISSION_INTERNAL_PURCHASE_CAMERA);
            return;
        }
        try {
            Intent intent = new Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE);
            if (intent.resolveActivity(getPackageManager()) == null) throw new IllegalStateException("Câmera indisponível neste aparelho");
            startActivityForResult(intent, REQUEST_INTERNAL_PURCHASE_RECEIPT);
        } catch (Exception error) {
            if (webView != null) webView.evaluateJavascript("window.onInternalPurchaseReceipt && window.onInternalPurchaseReceipt(false,'Não foi possível abrir a câmera. Verifique a permissão e tente novamente.');", null);
        }
    }

    private String deviceAuditId() { return Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID); }

    private String imageBase64(File file) throws Exception {
        byte[] bytes = new byte[(int) file.length()];
        try (FileInputStream input = new FileInputStream(file)) { input.read(bytes); }
        return Base64.encodeToString(bytes, Base64.NO_WRAP);
    }

    private void bindAuditProfile(String name) {
        new Thread(() -> {
            try {
                String path = prefs.getString("last_selfie_path", "");
                if (!path.isEmpty()) {
                    JSONObject body = new JSONObject().put("action", "bind_profile").put("driver_name", name).put("device_id", deviceAuditId()).put("selfie_base64", imageBase64(new File(path)));
                    postAudit(body);
                }
            } catch (Exception error) { Log.e("AUDIT", "Selfie audit bind failed", error); }
        }).start();
    }

    private void postEmergencyAudit(String action, String orderId, String name, String productBase64) {
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject().put("action", action).put("order_id", orderId).put("driver_name", name).put("device_id", deviceAuditId());
                if (productBase64 != null) body.put("product_base64", productBase64);
                postAudit(body);
            } catch (Exception error) { Log.e("AUDIT", "Emergency audit failed", error); }
        }).start();
    }

    private void postInternalPurchaseReceipt(String imageBase64) {
        final String purchaseId = internalPurchaseId, orderId = internalPurchaseOrderId, driver = internalPurchaseDriver, summary = internalPurchaseSummary;
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject().put("action", "internal_purchase_receipt").put("purchase_id", purchaseId)
                        .put("order_id", orderId).put("driver_name", driver).put("purchase_summary", summary)
                        .put("device_id", deviceAuditId()).put("receipt_base64", imageBase64);
                postAudit(body);
                internalPurchaseImageBase64 = null;
                if (webView != null) webView.post(() -> webView.evaluateJavascript("window.onInternalPurchaseReceipt && window.onInternalPurchaseReceipt(true,'Compra registrada. Nota fiscal enviada ao grupo de logística.');", null));
            } catch (Exception error) {
                if (webView != null) webView.post(() -> webView.evaluateJavascript("window.onInternalPurchaseReceipt && window.onInternalPurchaseReceipt(false,'Não foi possível enviar a nota fiscal. Tente novamente.');", null));
            }
        }).start();
    }

    private void postAudit(JSONObject body) throws Exception {
        java.net.HttpURLConnection connection = (java.net.HttpURLConnection) new java.net.URL(BuildConfig.SUPABASE_URL + "/functions/v1/emergency-audit").openConnection();
        connection.setRequestMethod("POST"); connection.setDoOutput(true); connection.setConnectTimeout(15000); connection.setReadTimeout(20000);
        connection.setRequestProperty("Content-Type", "application/json"); connection.setRequestProperty("apikey", BuildConfig.SUPABASE_ANON_KEY);
        try (java.io.OutputStream output = connection.getOutputStream()) { output.write(body.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
        int code = connection.getResponseCode(); connection.disconnect();
        if (code < 200 || code >= 300) throw new Exception("HTTP " + code);
    }

    private void startNativeScannerFromWeb(String mode) {
        webScannerMode = mode;
        message("Abrindo leitor de QR…");
        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{android.Manifest.permission.CAMERA}, PERMISSION_CAMERA);
            return;
        }
        try {
            notifyWebScannerStarting();
            new IntentIntegrator(this)
                    .setDesiredBarcodeFormats(com.google.zxing.BarcodeFormat.QR_CODE.toString())
                    .setPrompt("Aponte a câmera para o QR")
                    .setBeepEnabled(true)
                    .initiateScan();
        } catch (Exception error) {
            notifyWebScannerError("O leitor nativo não iniciou: " + error.getMessage());
        }
    }

    private void notifyWebScannerStarting() {
        if (webView == null) return;
        webView.post(() -> webView.evaluateJavascript("window.onNativeScannerStarting && window.onNativeScannerStarting();", null));
    }

    private void notifyWebScannerError(String message) {
        if (webView == null) return;
        String js = "window.onNativeScannerError && window.onNativeScannerError(" + JSONObject.quote(message) + ");";
        webView.post(() -> webView.evaluateJavascript(js, null));
    }

    private void showCameraSettings() {
        new AlertDialog.Builder(this)
                .setTitle("Permissão da câmera")
                .setMessage("O O Peixeiro precisa da câmera para ler o QR. Libere a permissão de câmera nas configurações do aplicativo e tente novamente.")
                .setNegativeButton("Cancelar", null)
                .setPositiveButton("Abrir configurações", (dialog, which) -> {
                    Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                    intent.setData(Uri.fromParts("package", getPackageName(), null));
                    startActivity(intent);
                })
                .show();
    }

    private void loadMotoristaName() {
        motoristaNome = prefs.getString("motorista_nome", "");
        if (motoristaNome.isEmpty()) {
            showMotoristaSelector();
        }
    }

    private void showMotoristaSelector() {
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Qual é seu nome?")
                .setItems(new String[]{"Edmar", "João", "Pedro", "Outro"}, (d, which) -> {
                    if (which == 3) {
                        showCustomMotoristaInput();
                    } else {
                        String[] nomes = {"Edmar", "João", "Pedro"};
                        motoristaNome = nomes[which];
                        prefs.edit().putString("motorista_nome", motoristaNome).apply();
                    }
                })
                .setCancelable(false)
                .create();
        dialog.show();
    }

    private void showCustomMotoristaInput() {
        EditText input = new EditText(this);
        input.setHint("Digite seu nome");
        input.setInputType(InputType.TYPE_CLASS_TEXT);

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Seu nome")
                .setView(input)
                .setPositiveButton("OK", (d, w) -> {
                    String nome = input.getText().toString().trim();
                    if (!nome.isEmpty()) {
                        motoristaNome = nome;
                        prefs.edit().putString("motorista_nome", motoristaNome).apply();
                    }
                })
                .setCancelable(false)
                .create();
        dialog.show();
    }

    private void checkForUpdate() {
        new Thread(() -> {
            try {
                String json = fetchText("https://api.github.com/repos/" + GITHUB_REPO + "/releases/latest");
                if (json == null || json.isEmpty()) return;
                JSONObject release = new JSONObject(json);
                String remoteTag = release.optString("tag_name", "").trim();
                if (remoteTag.isEmpty()) return;
                
                String currentVersion = BuildConfig.VERSION_NAME;
                if (!isVersionNewer(remoteTag, currentVersion)) return;
                
                String apkUrl = GITHUB_RELEASE_URL;
                JSONArray assets = release.optJSONArray("assets");
                if (assets != null) {
                    for (int i = 0; i < assets.length(); i++) {
                        JSONObject asset = assets.optJSONObject(i);
                        String browserUrl = asset.optString("browser_download_url", "");
                        if (browserUrl.toLowerCase().endsWith(".apk")) {
                            apkUrl = browserUrl;
                            break;
                        }
                    }
                }
                
                final String finalUrl = apkUrl;
                runOnUiThread(() -> showForceUpdateDialog(finalUrl));
            } catch (Exception ignored) {}
        }).start();
    }

    private void showForceUpdateDialog(String updateUrl) {
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Nova versão disponível")
                .setMessage("Instale a versão mais recente para continuar.")
                .setCancelable(false)
                .setPositiveButton("Atualizar", (d, w) -> {
                    Intent browser = new Intent(Intent.ACTION_VIEW, Uri.parse(updateUrl));
                    startActivity(browser);
                    finishAffinity();
                })
                .setNegativeButton("Sair", (d, w) -> finishAffinity())
                .create();
        dialog.show();
    }

    private boolean isVersionNewer(String remoteTag, String currentVersion) {
        int[] remoteParts = parseVersion(remoteTag);
        int[] currentParts = parseVersion(currentVersion);
        for (int i = 0; i < 3; i++) {
            if (remoteParts[i] > currentParts[i]) return true;
            if (remoteParts[i] < currentParts[i]) return false;
        }
        return false;
    }

    private int[] parseVersion(String version) {
        int[] parts = new int[]{0, 0, 0};
        if (version == null || version.trim().isEmpty()) return parts;
        String normalized = version.trim();
        if (normalized.startsWith("v") || normalized.startsWith("V")) normalized = normalized.substring(1);
        String[] tokens = normalized.split("[^0-9]+");
        int index = 0;
        for (String token : tokens) {
            if (token == null || token.isEmpty()) continue;
            if (index >= 3) break;
            try {
                parts[index++] = Integer.parseInt(token);
            } catch (NumberFormatException ignored) {}
        }
        return parts;
    }

    private String fetchText(String urlString) throws Exception {
        java.net.HttpURLConnection connection = (java.net.HttpURLConnection) new java.net.URL(urlString).openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(15000);
        connection.setRequestProperty("User-Agent", "OPeixeiroApp/1.0");
        int status = connection.getResponseCode();
        if (status != java.net.HttpURLConnection.HTTP_OK) return null;
        java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.InputStreamReader(connection.getInputStream()));
        StringBuilder content = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) content.append(line);
        reader.close();
        connection.disconnect();
        return content.toString();
    }

    private void showHome() {
        ScrollView scroll = new ScrollView(this);
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(20), dp(36), dp(20), dp(36));
        content.setBackgroundColor(Color.parseColor("#07131B"));
        scroll.addView(content);
        setContentView(scroll);

        content.addView(labelDark("🐟 O Peixeiro Motorista", 30f, Color.WHITE));
        content.addView(labelDark("Entrega, conferência e faltantes", 15f, Color.parseColor("#BFD2D6")));
        content.addView(labelDark("\nMotorista: " + motoristaNome, 14f, Color.parseColor("#88D9D9")));

        actionCard("📱 ESCANEAR QR", "Aponte para o QR do pedido", this::startQRScan);
        actionCard("📋 CONFERIR", "Ajuste quantidades e faltantes", () -> {
            if (!pedidoItems.isEmpty()) showConferencia();
            else message("Escaneie um QR primeiro!");
        });
        actionCard("✅ CONFIRMAR", "Finalize a entrega", () -> {
            if (!pedidoItems.isEmpty()) showConfirmarEntrega();
            else message("Escaneie um QR primeiro!");
        });
    }

    private void startQRScan() {
        if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{android.Manifest.permission.CAMERA}, PERMISSION_CAMERA);
        } else {
            new IntentIntegrator(this)
                    .setDesiredBarcodeFormats(com.google.zxing.BarcodeFormat.QR_CODE.toString())
                    .setPrompt("Aponte a câmera para o QR")
                    .setCameraId(0)
                    .setBeepEnabled(true)
                    .initiateScan();
        }
    }

    @Override
    public void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_EMERGENCY_PRODUCT_PHOTO) {
            if (resultCode == RESULT_OK && data != null && data.getExtras() != null && data.getExtras().get("data") instanceof Bitmap) {
                Bitmap bitmap = (Bitmap) data.getExtras().get("data");
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                bitmap.compress(Bitmap.CompressFormat.JPEG, 88, output);
                postEmergencyAudit("product_evidence", emergencyProductOrderId, emergencyProductDriver, Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP));
                message("Foto da emergência registrada e enviada para auditoria.");
            } else message("A foto do produto é obrigatória para concluir esta coleta emergencial.");
            emergencyProductOrderId = null; emergencyProductDriver = null;
            return;
        }
        if (requestCode == REQUEST_INTERNAL_PURCHASE_RECEIPT) {
            if (resultCode == RESULT_OK && data != null && data.getExtras() != null && data.getExtras().get("data") instanceof Bitmap) {
                Bitmap bitmap = (Bitmap) data.getExtras().get("data"); ByteArrayOutputStream output = new ByteArrayOutputStream(); bitmap.compress(Bitmap.CompressFormat.JPEG, 90, output);
                internalPurchaseImageBase64 = Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP);
                if (webView != null) webView.evaluateJavascript("window.onInternalPurchasePhotoCaptured && window.onInternalPurchasePhotoCaptured(true,'Foto tirada. Agora toque em Salvar compra e enviar comprovante.');", null);
            } else if (webView != null) webView.evaluateJavascript("window.onInternalPurchasePhotoCaptured && window.onInternalPurchasePhotoCaptured(false,'A foto da nota fiscal é obrigatória.');", null);
            return;
        }
        IntentResult result = IntentIntegrator.parseActivityResult(requestCode, resultCode, data);
        if (result != null && webScannerMode != null) {
            String mode = webScannerMode;
            webScannerMode = null;
            if (result.getContents() != null) {
                String js = "window.onNativeQrScan(" + JSONObject.quote(mode) + "," + JSONObject.quote(result.getContents()) + ");";
                webView.evaluateJavascript(js, null);
            } else {
                webView.evaluateJavascript("window.onNativeQrCancelled();", null);
            }
        } else if (result != null && result.getContents() != null) {
            processQRCode(result.getContents());
        }
    }

    private void processQRCode(String qrContent) {
        try {
            if (qrContent.trim().startsWith("{")) {
                JSONObject qr = new JSONObject(qrContent);
                if ("opeixeiro_dispatch_release".equals(qr.optString("type")) && qr.has("release_token")) {
                    processDispatchRelease(qr.getString("release_token"));
                    return;
                }
            }
            String[] parts = qrContent.split("\\|");
            if (parts.length < 5) { message("QR inválido!"); return; }

            pedidoUnit = parts[2];
            String itemsStr = parts[4];

            pedidoItems.clear();
            itemsMap.clear();
            String[] items = itemsStr.split(";");
            for (String item : items) {
                String[] itemParts = item.split("-");
                if (itemParts.length == 2) {
                    try {
                        String product = itemParts[0].trim();
                        int qty = Integer.parseInt(itemParts[1].trim());
                        PedidoItem pi = new PedidoItem(product, qty);
                        pedidoItems.add(pi);
                        itemsMap.put(product, pi);
                    } catch (NumberFormatException e) {
                        Log.e("QR_PARSE", "Error parsing item", e);
                    }
                }
            }

            pedidoQR = qrContent;
            message("✅ " + pedidoUnit + " carregado! " + pedidoItems.size() + " itens.");
            showConferencia();
        } catch (Exception e) {
            Log.e("QR_PARSE", "Error", e);
            message("Erro ao processar QR");
        }
    }

    private void processDispatchRelease(String releaseToken) {
        message("Validando liberação da coleta...");
        supabaseClient.validateAndScanRelease(releaseToken, motoristaNome, new SupabaseClient.Callback() {
            @Override public void onSuccess(String result) {
                runOnUiThread(() -> {
                    try {
                        JSONObject release = new JSONObject(result);
                        pedidoId = release.optString("order_id");
                        pedidoUnit = release.optString("origin_unit_id");
                        pedidoQR = releaseToken;
                        pedidoItems.clear();
                        itemsMap.clear();
                        JSONArray items = release.optJSONArray("items");
                        if (items != null) for (int i = 0; i < items.length(); i++) {
                            JSONObject item = items.getJSONObject(i);
                            PedidoItem pi = new PedidoItem(item.optString("name"), (int) Math.round(item.optDouble("qty", 0)));
                            pedidoItems.add(pi);
                            itemsMap.put(pi.product, pi);
                        }
                        message("Coleta liberada e registrada!");
                        showConferencia();
                    } catch (Exception e) { message("QR lido, mas não foi possível abrir os itens."); }
                });
            }
            @Override public void onError(String error) { runOnUiThread(() -> message("Coleta não liberada: " + error)); }
        });
    }

    private void showConferencia() {
        ScrollView scroll = new ScrollView(this);
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(20), dp(20), dp(20), dp(20));
        content.setBackgroundColor(Color.parseColor("#07131B"));
        scroll.addView(content);
        setContentView(scroll);

        content.addView(labelDark("📦 CONFERÊNCIA - " + pedidoUnit, 24f, Color.WHITE));
        content.addView(labelDark("Ajuste quantidades e marque faltantes", 14f, Color.parseColor("#BFD2D6")));
        content.addView(labelDark("", 8f, Color.WHITE));

        for (PedidoItem item : pedidoItems) {
            addConferenciaRow(item);
        }

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setPadding(0, dp(20), 0, 0);

        MaterialButton backBtn = new MaterialButton(this);
        backBtn.setText("Voltar");
        backBtn.setBackgroundColor(Color.parseColor("#238F84"));
        backBtn.setTextColor(Color.WHITE);
        backBtn.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        backBtn.setOnClickListener(v -> showHome());

        MaterialButton nextBtn = new MaterialButton(this);
        nextBtn.setText("Confirmar");
        nextBtn.setBackgroundColor(Color.parseColor("#FF6B6B"));
        nextBtn.setTextColor(Color.WHITE);
        LinearLayout.LayoutParams nextParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        nextParams.setMargins(dp(8), 0, 0, 0);
        nextBtn.setLayoutParams(nextParams);
        nextBtn.setOnClickListener(v -> showConfirmarEntrega());

        buttons.addView(backBtn);
        buttons.addView(nextBtn);
        content.addView(buttons);
    }

    private void addConferenciaRow(PedidoItem item) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        row.setBackgroundColor(Color.parseColor("#0F2129"));
        row.setPadding(dp(12), dp(12), dp(12), dp(12));
        LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        rowParams.setMargins(0, 0, 0, dp(8));
        row.setLayoutParams(rowParams);

        TextView productName = labelDark(item.product, 16f, Color.WHITE);
        row.addView(productName);

        LinearLayout qtyRow = new LinearLayout(this);
        qtyRow.setOrientation(LinearLayout.HORIZONTAL);
        qtyRow.setPadding(0, dp(8), 0, dp(8));

        EditText qtyField = new EditText(this);
        qtyField.setText(String.valueOf(item.quantidadeConfirmada));
        qtyField.setInputType(InputType.TYPE_CLASS_NUMBER);
        qtyField.setTextColor(Color.WHITE);
        qtyField.setBackgroundColor(Color.parseColor("#123B43"));
        qtyField.setPadding(dp(12), dp(10), dp(12), dp(10));
        qtyField.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        qtyField.setOnFocusChangeListener((v, hasFocus) -> {
            if (!hasFocus) {
                try {
                    item.quantidadeConfirmada = Integer.parseInt(qtyField.getText().toString());
                } catch (NumberFormatException e) {
                    item.quantidadeConfirmada = 0;
                }
            }
        });

        TextView esperado = labelDark("Esperado: " + item.quantidadeEsperada, 12f, Color.parseColor("#BFD2D6"));
        LinearLayout.LayoutParams esperParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        esperParams.setMargins(dp(8), 0, 0, 0);
        esperado.setLayoutParams(esperParams);

        qtyRow.addView(qtyField);
        qtyRow.addView(esperado);
        row.addView(qtyRow);

        LinearLayout checksRow = new LinearLayout(this);
        checksRow.setOrientation(LinearLayout.HORIZONTAL);
        checksRow.setPadding(0, dp(8), 0, 0);

        CheckBox faltanteCheck = new CheckBox(this);
        faltanteCheck.setText("Faltante");
        faltanteCheck.setTextColor(Color.parseColor("#FFD700"));
        faltanteCheck.setChecked(item.faltante);
        faltanteCheck.setOnCheckedChangeListener((v, isChecked) -> item.faltante = isChecked);
        faltanteCheck.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        CheckBox avariaCheck = new CheckBox(this);
        avariaCheck.setText("Avaria");
        avariaCheck.setTextColor(Color.parseColor("#FF6B6B"));
        avariaCheck.setChecked(item.avaria);
        avariaCheck.setOnCheckedChangeListener((v, isChecked) -> item.avaria = isChecked);
        avariaCheck.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        checksRow.addView(faltanteCheck);
        checksRow.addView(avariaCheck);
        row.addView(checksRow);

        content.addView(row);
    }

    private void showConfirmarEntrega() {
        ScrollView scroll = new ScrollView(this);
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(20), dp(20), dp(20), dp(20));
        content.setBackgroundColor(Color.parseColor("#07131B"));
        scroll.addView(content);
        setContentView(scroll);

        content.addView(labelDark("✅ CONFIRMAR ENTREGA", 24f, Color.WHITE));
        content.addView(labelDark("Revise antes de confirmar", 14f, Color.parseColor("#BFD2D6")));
        content.addView(labelDark("", 8f, Color.WHITE));

        int faltantes = 0, avarias = 0;
        for (PedidoItem item : pedidoItems) {
            if (item.faltante) faltantes++;
            if (item.avaria) avarias++;
        }

        content.addView(labelDark("📋 Resumo", 16f, Color.parseColor("#88D9D9")));
        content.addView(labelDark("Unidade: " + pedidoUnit, 13f, Color.WHITE));
        content.addView(labelDark("Motorista: " + motoristaNome, 13f, Color.WHITE));
        content.addView(labelDark("Total itens: " + pedidoItems.size(), 13f, Color.WHITE));
        content.addView(labelDark("Faltantes: " + faltantes, 13f, Color.parseColor("#FFD700")));
        content.addView(labelDark("Avarias: " + avarias, 13f, Color.parseColor("#FF6B6B")));
        content.addView(labelDark("", 8f, Color.WHITE));

        content.addView(labelDark("Observações (opcional):", 14f, Color.parseColor("#BFD2D6")));
        EditText obsField = new EditText(this);
        obsField.setHint("Deixe uma anotação");
        obsField.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        obsField.setTextColor(Color.WHITE);
        obsField.setHintTextColor(Color.parseColor("#B4C5C8"));
        obsField.setBackgroundColor(Color.parseColor("#123B43"));
        obsField.setMinLines(3);
        obsField.setPadding(dp(12), dp(10), dp(12), dp(10));
        LinearLayout.LayoutParams obsParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        obsParams.setMargins(0, dp(8), 0, dp(16));
        obsField.setLayoutParams(obsParams);
        content.addView(obsField);

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);

        MaterialButton cancelBtn = new MaterialButton(this);
        cancelBtn.setText("Cancelar");
        cancelBtn.setBackgroundColor(Color.parseColor("#238F84"));
        cancelBtn.setTextColor(Color.WHITE);
        cancelBtn.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        cancelBtn.setOnClickListener(v -> showHome());

        MaterialButton confirmBtn = new MaterialButton(this);
        confirmBtn.setText("✅ CONFIRMAR");
        confirmBtn.setBackgroundColor(Color.parseColor("#00AA00"));
        confirmBtn.setTextColor(Color.WHITE);
        LinearLayout.LayoutParams confirmParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        confirmParams.setMargins(dp(8), 0, 0, 0);
        confirmBtn.setLayoutParams(confirmParams);
        confirmBtn.setOnClickListener(v -> {
            confirmBtn.setEnabled(false);
            confirmBtn.setText("Enviando...");
            submitConfirmacao(obsField.getText().toString());
        });

        buttons.addView(cancelBtn);
        buttons.addView(confirmBtn);
        content.addView(buttons);
    }

    private void submitConfirmacao(String observacoes) {
        try {
            JSONArray itemsConfirmados = new JSONArray();
            JSONArray itemsFaltantes = new JSONArray();
            JSONArray itemsAvarias = new JSONArray();

            for (PedidoItem item : pedidoItems) {
                JSONObject itemObj = new JSONObject();
                itemObj.put("product", item.product);
                itemObj.put("quantity_confirmed", item.quantidadeConfirmada);
                itemObj.put("quantity_expected", item.quantidadeEsperada);
                itemsConfirmados.put(itemObj);

                if (item.faltante) itemsFaltantes.put(item.product);
                if (item.avaria) itemsAvarias.put(item.product);
            }

            String orderId = pedidoUnit + "_" + System.currentTimeMillis();

            supabaseClient.confirmOrder(
                orderId, motoristaNome, itemsConfirmados, itemsFaltantes, itemsAvarias, observacoes,
                new SupabaseClient.Callback() {
                    @Override
                    public void onSuccess(String result) {
                        runOnUiThread(() -> {
                            message("✅ Entrega confirmada!");
                            pedidoItems.clear();
                            itemsMap.clear();
                            showHome();
                        });
                    }

                    @Override
                    public void onError(String error) {
                        runOnUiThread(() -> {
                            message("❌ Erro: " + error);
                            showHome();
                        });
                    }
                }
            );
        } catch (JSONException e) {
            Log.e("CONFIRM", "Error", e);
            message("Erro ao processar confirmação");
        }
    }

    private TextView labelDark(String text, float size, int color) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setPadding(0, dp(4), 0, dp(4));
        return view;
    }

    private void actionCard(String title, String subtitle, Runnable action) {
        MaterialButton button = new MaterialButton(this);
        button.setText(title + "\n" + subtitle);
        button.setTextSize(15f);
        button.setAllCaps(false);
        button.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        button.setTextColor(Color.WHITE);
        button.setBackgroundColor(Color.parseColor("#1A2A33"));
        button.setCornerRadius(dp(14));
        button.setPadding(dp(20), dp(18), dp(20), dp(18));
        button.setOnClickListener(v -> action.run());

        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.setMargins(0, dp(10), 0, dp(10));
        button.setLayoutParams(params);
        content.addView(button);
    }

    private void message(String text) {
        Toast.makeText(this, text, Toast.LENGTH_LONG).show();
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == PERMISSION_SELFIE_CAMERA) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) showSelfieVerification();
            else {
                Toast.makeText(this, "A verificação por selfie exige a câmera.", Toast.LENGTH_LONG).show();
                showCameraSettings();
            }
            return;
        }
        if (requestCode == PERMISSION_CAMERA) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                if (webScannerMode != null) startNativeScannerFromWeb(webScannerMode);
                else startQRScan();
            } else {
                message("Permissão de câmera necessária!");
                notifyWebScannerError("Câmera bloqueada pelo Android. Toque em “Abrir configurações” e permita o uso da câmera.");
                showCameraSettings();
            }
            return;
        }
        if (requestCode == PERMISSION_INTERNAL_PURCHASE_CAMERA) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) launchInternalPurchaseCamera();
            else if (webView != null) webView.evaluateJavascript("window.onInternalPurchaseReceipt && window.onInternalPurchaseReceipt(false,'A câmera é necessária para fotografar a nota fiscal.');", null);
        }
    }
}
