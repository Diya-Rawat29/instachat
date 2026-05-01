$envVars = @{
    "NEXT_PUBLIC_FIREBASE_API_KEY" = "AIzaSyBJ_oJc-NtfQgnL1PPB7MFT-SSg6VWjp4E"
    "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN" = "first-b62bb.firebaseapp.com"
    "NEXT_PUBLIC_FIREBASE_PROJECT_ID" = "first-b62bb"
    "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET" = "first-b62bb.firebasestorage.app"
    "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID" = "253322662920"
    "NEXT_PUBLIC_FIREBASE_APP_ID" = "1:253322662920:web:5269008bd603371e2dadbd"
    "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID" = "G-725LYC6WEZ"
    "NEXT_PUBLIC_API_URL" = "https://instachat-ryyi.onrender.com"
    "NEXT_PUBLIC_SOCKET_SERVER_URL" = "https://instachat-ryyi.onrender.com"
}

foreach ($key in $envVars.Keys) {
    $value = $envVars[$key]
    Write-Host "Setting $key"
    npx vercel env rm $key production -y 2>$null
    $value | npx vercel env add $key production
}

Write-Host "Done setting env vars. Triggering Vercel deploy..."
npx vercel --prod -y
