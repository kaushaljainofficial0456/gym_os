package com.gymos.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import androidx.annotation.RequiresApi;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;

/** Saves a file the web app downloaded (an invoice PDF) and opens it. */
final class Downloads {

    static final String FALLBACK_NAME = "GymOS-download";
    private static final int MAX_NAME_LENGTH = 120;

    private Downloads() {}

    /**
     * The page picks the name, so it is untrusted: no path separators, no
     * reserved or control characters, no leading dots, bounded length (cut
     * from the front, so the extension survives).
     */
    static String safeFileName(String requested) {
        String name = requested == null ? "" : requested.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (name.length() > MAX_NAME_LENGTH) {
            name = name.substring(name.length() - MAX_NAME_LENGTH);
        }
        name = name.replaceFirst("^\\.+", "").trim();
        return name.isEmpty() ? FALLBACK_NAME : name;
    }

    static Uri save(Context context, String fileName, String mimeType, byte[] bytes) throws IOException {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return saveToDownloads(context, fileName, mimeType, bytes);
        }
        // Android 7-9 have no MediaStore Downloads collection, and writing to the
        // shared Downloads folder there takes a storage permission GymOS does not
        // ask for. The app's own Downloads folder needs none.
        File dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null || (!dir.isDirectory() && !dir.mkdirs())) {
            throw new IOException("External storage is unavailable");
        }
        File file = uniqueFile(dir, fileName);
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(bytes);
        }
        return FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    private static Uri saveToDownloads(Context context, String fileName, String mimeType, byte[] bytes) throws IOException {
        ContentResolver resolver = context.getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) {
            throw new IOException("Downloads refused the file");
        }
        try (OutputStream out = resolver.openOutputStream(uri)) {
            if (out == null) {
                throw new IOException("Downloads gave no output stream");
            }
            out.write(bytes);
        } catch (IOException e) {
            resolver.delete(uri, null, null);
            throw e;
        }
        values.clear();
        values.put(MediaStore.MediaColumns.IS_PENDING, 0);
        resolver.update(uri, values, null, null);
        return uri;
    }

    private static File uniqueFile(File dir, String fileName) {
        int dot = fileName.lastIndexOf('.');
        String base = dot > 0 ? fileName.substring(0, dot) : fileName;
        String extension = dot > 0 ? fileName.substring(dot) : "";
        File file = new File(dir, fileName);
        for (int n = 1; file.exists(); n++) {
            file = new File(dir, base + " (" + n + ")" + extension);
        }
        return file;
    }

    static void open(Activity activity, Uri uri, String mimeType) {
        Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mimeType).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            activity.startActivity(view);
        } catch (ActivityNotFoundException e) {
            // Still saved; the confirmation toast already said where.
        }
    }
}
