exports.handler = async () => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "GOOGLE_MAPS_API_KEY is not configured." }),
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ googleMapsApiKey: apiKey }),
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  };
};
