export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { apiKey, secretKey, accountNumber, shipTo, shipFrom, serviceType, caseNumber, weight } = req.body;

    // Step 1: Get OAuth token
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

    // Step 2: Create shipment
    const payload = {
        labelResponseOptions: 'URL_ONLY',
        requestedShipment: {
            shipper: {
                contact: {
                    personName: shipFrom.contact,
                    phoneNumber: shipFrom.phone.replace(/\D/g,''),
                    companyName: shipFrom.company
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
                    personName: shipTo.name,
                    phoneNumber: (shipTo.phone || '4025550000').replace(/\D/g,''),
                    companyName: shipTo.company || ''
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
                    value: weight || 2
                },
                customerReferences: [{
                    customerReferenceType: 'CUSTOMER_REFERENCE',
                    value: caseNumber
                }]
            }]
        },
        accountNumber: { value: accountNumber }
    };

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
        const shipData = await shipRes.json();

        if (shipData.errors) return res.status(400).json({ error: 'FedEx error', detail: shipData.errors });

        const output = shipData.output?.transactionShipments?.[0];
        const labelUrl = output?.pieceResponses?.[0]?.packageDocuments?.[0]?.url;
        const trackingNumber = output?.pieceResponses?.[0]?.trackingNumber;

        if (!labelUrl && !trackingNumber) return res.status(400).json({ error: 'No label returned', detail: shipData });

        return res.status(200).json({ labelUrl, trackingNumber });
    } catch(e) {
        return res.status(500).json({ error: 'Shipment request failed', detail: e.message });
    }
}
