$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:3000/")
$listener.Start()
Write-Host "Server running on http://localhost:3000"

$mimeTypes = @{
    '.html' = 'text/html; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.png'  = 'image/png'
    '.ico'  = 'image/x-icon'
    '.webmanifest' = 'application/manifest+json'
}

$root = $PSScriptRoot

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        $path = $request.Url.LocalPath
        if ($path -eq '/') { $path = '/index.html' }

        $filePath = Join-Path $root $path.TrimStart('/')

        if (Test-Path $filePath -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($filePath)
            $contentType = $mimeTypes[$ext]
            if (-not $contentType) { $contentType = 'application/octet-stream' }

            $response.ContentType = $contentType
            $response.StatusCode = 200
            $bytes = [System.IO.File]::ReadAllBytes($filePath)
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $response.StatusCode = 404
            $msg = [System.Text.Encoding]::UTF8.GetBytes("Not Found")
            $response.OutputStream.Write($msg, 0, $msg.Length)
        }

        $response.Close()
    }
} finally {
    $listener.Stop()
}
