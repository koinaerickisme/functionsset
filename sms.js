const axios = require('axios');

class SmsService {
  constructor() {
    this.apiKey = "9981bb72e1a2e1ec8ae529c7783abe06";
    this.partnerId = "14125";
    this.shortcode = "BLANCOSY";
    this.baseUrl = "https://sms.fastmessage.co.ke/api/services/sendsms";
  }

  /**
   * Sends an SMS message to the specified mobile number
   * @param {string} mobile - The recipient's mobile number (e.g., "254758277793")
   * @param {string} message - The SMS message content
   * @returns {Promise<Object>} Response object with success status and details
   */
  async sendSms(mobile, message) {
    try {
      if (!mobile || !message) {
        return {
          success: false,
          statusCode: 400,
          message: 'Mobile number and message are required',
          data: null
        };
      }

      // Format and validate mobile number
      const formattedMobile = this.formatMobileNumber(mobile);
      if (!this.isValidMobileNumber(formattedMobile)) {
        return {
          success: false,
          statusCode: 400,
          message: 'Invalid mobile number format',
          data: null
        };
      }

      // Prepare the request body
      const requestBody = {
        apikey: this.apiKey,
        partnerID: this.partnerId,
        message: message,
        shortcode: this.shortcode,
        mobile: formattedMobile,
      };

      // Make the POST request
      const response = await axios.post(this.baseUrl, requestBody, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        timeout: 30000 // 30 seconds timeout
      });

      return {
        success: true,
        statusCode: response.status,
        message: response.data.message || 'SMS sent successfully',
        data: response.data
      };

    } catch (error) {
      // Handle different types of errors
      if (error.response) {
        // The request was made and the server responded with a status code
        return {
          success: false,
          statusCode: error.response.status,
          message: error.response.data?.message || 'API request failed',
          data: error.response.data
        };
      } else if (error.request) {
        // The request was made but no response was received
        return {
          success: false,
          statusCode: 0,
          message: 'Network error: No response from server',
          data: null
        };
      } else {
        // Something happened in setting up the request
        return {
          success: false,
          statusCode: 0,
          message: `Error sending SMS: ${error.message}`,
          data: null
        };
      }
    }
  }

  /**
   * Validates a mobile number format
   * @param {string} mobile - The mobile number to validate
   * @returns {boolean} True if the mobile number appears to be in a valid format
   */
  isValidMobileNumber(mobile) {
    // Basic validation for Kenyan mobile numbers starting with 254
    const mobileRegex = /^254[0-9]{9}$/;
    return mobileRegex.test(mobile);
  }

  /**
   * Formats a mobile number to the required format
   * @param {string} mobile - The mobile number to format (can start with 0, +254, or 254)
   * @returns {string} The formatted mobile number starting with 254
   */
  formatMobileNumber(mobile) {
    if (!mobile) return '';
    
    // Remove any spaces, dashes, or other non-numeric characters except +
    mobile = mobile.toString().replace(/[^\d+]/g, '');
    
    // Handle different input formats
    if (mobile.startsWith('+254')) {
      return mobile.substring(1); // Remove the + sign
    } else if (mobile.startsWith('0')) {
      return '254' + mobile.substring(1); // Replace 0 with 254
    } else if (mobile.startsWith('254')) {
      return mobile; // Already in correct format
    } else if (mobile.length === 9) {
      return '254' + mobile; // Assume it's missing the country code
    }
    
    return mobile; // Return as-is if format is unclear
  }

  /**
   * Sends multiple SMS messages (bulk SMS)
   * @param {Array} recipients - Array of objects with mobile and message properties
   * @returns {Promise<Array>} Array of response objects
   */

}

// Create a singleton instance
const smsService = new SmsService();

// Export the service instance and the class
module.exports = {
  SmsService,
  smsService
};