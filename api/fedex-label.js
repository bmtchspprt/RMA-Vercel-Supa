export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const {
        apiKey, secretKey, accountNumber,
        shipFrom, shipTo, serviceType,
        caseNumber, packagePreset,
        supabaseUrl, supabaseKey
    } = req.body;

    // ── Step 1: Auth ────────────────────────────────────────────────
    let token;
    try {
        const authRes = await fetch('https://apis.fedex.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `grant_type=client_credentials&client_id=${encodeURIComponent(apiKey)}&client_secret=${encodeURIComponent(secretKey)}`
        });
        const authData = await authRes.json();
        if (!authData.access_token) return res.status(401).json({ error: 'FedEx auth failed', detail: authData });
        token = authData.access_token;
    } catch(e) {
        return res.status(500).json({ error: 'Auth request failed', detail: e.message });
    }

    // ── Step 2: Create shipment ─────────────────────────────────────
    const payload = {
        labelResponseOptions: 'LABEL',
        requestedShipment: {
            shipper: {
                contact: {
                    personName: shipFrom.name,
                    phoneNumber: (shipFrom.phone || '4025550000').replace(/\D/g,''),
                    companyName: shipFrom.company || ''
                },
                address: {
                    streetLines: [shipFrom.address],
                    city: shipFrom.city,
                    stateOrProvinceCode: shipFrom.state,
                    postalCode: shipFrom.zip,
                    countryCode: 'US'
                }
            },
            recipients: [{
                contact: {
                    personName: shipTo.contact,
                    phoneNumber: (shipTo.phone || '8002784241').replace(/\D/g,''),
                    companyName: shipTo.company
                },
                address: {
                    streetLines: [shipTo.address],
                    city: shipTo.city,
                    stateOrProvinceCode: shipTo.state,
                    postalCode: shipTo.zip,
                    countryCode: 'US'
                }
            }],
            shipDatestamp: new Date().toISOString().split('T')[0],
            serviceType: serviceType || 'FEDEX_GROUND',
            packagingType: 'YOUR_PACKAGING',
            pickupType: 'USE_SCHEDULED_PICKUP',
            shippingChargesPayment: {
                paymentType: 'SENDER',
                payor: {
                    responsibleParty: {
                        accountNumber: { value: accountNumber }
                    }
                }
            },
            labelSpecification: {
                labelFormatType: 'COMMON2D',
                imageType: 'PDF',
                labelStockType: 'PAPER_85X11_TOP_HALF_LABEL'
            },
            requestedPackageLineItems: [{
                weight: {
                    units: 'LB',
                    value: packagePreset.weight || 2
                },
                dimensions: {
                    length: packagePreset.length || 12,
                    width: packagePreset.width || 10,
                    height: packagePreset.height || 6,
                    units: 'IN'
                },
                customerReferences: [{
                    customerReferenceType: 'CUSTOMER_REFERENCE',
                    value: caseNumber
                }]
            }]
        },
        accountNumber: { value: accountNumber }
    };

    let shipData;
    try {
        const shipRes = await fetch('https://apis.fedex.com/ship/v1/shipments', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'X-locale': 'en_US'
            },
            body: JSON.stringify(payload)
        });
        shipData = await shipRes.json();
    } catch(e) {
        return res.status(500).json({ error: 'Shipment request failed', detail: e.message });
    }

    if (shipData.errors) return res.status(400).json({ error: 'FedEx error', detail: shipData.errors });

    const output = shipData.output?.transactionShipments?.[0];
    const trackingNumber = output?.pieceResponses?.[0]?.trackingNumber;
    const labelBase64 = output?.pieceResponses?.[0]?.packageDocuments?.[0]?.encodedLabel;

    if (!labelBase64) return res.status(400).json({ error: 'No label data returned', detail: shipData });

    // ── Step 3: Upload label PDF to Supabase media/fedex-labels/ ────
    const today = new Date().toISOString().split('T')[0];
    const filename = `fedex-labels/${caseNumber}_${today}_${trackingNumber}.pdf`;

    // Convert base64 to binary
    const pdfBuffer = Buffer.from(labelBase64, 'base64');

    let labelUrl;
    try {
        const uploadRes = await fetch(
            `${supabaseUrl}/storage/v1/object/media/${filename}`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${supabaseKey}`,
                    'Content-Type': 'application/pdf',
                    'x-upsert': 'true'
                },
                body: pdfBuffer
            }
        );
        if (!uploadRes.ok) {
            const uploadErr = await uploadRes.text();
            return res.status(500).json({ error: 'Label upload failed', detail: uploadErr });
        }
        labelUrl = `${supabaseUrl}/storage/v1/object/public/media/${filename}`;
    } catch(e) {
        return res.status(500).json({ error: 'Upload request failed', detail: e.message });
    }

    return res.status(200).json({ trackingNumber, labelUrl });
}
