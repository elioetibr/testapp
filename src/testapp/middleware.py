import ipaddress

from django.http import HttpResponseForbidden


class VPCHealthCheckMiddleware:
    """
    Middleware to restrict health check endpoint access to VPC internal IPs only.

    This middleware checks if requests to /health/ endpoints are coming from
    private IP ranges typically used in VPC environments. External requests
    to health check endpoints are denied with a 403 Forbidden response.
    """

    def __init__(self, get_response):
        self.get_response = get_response
        # VPC CIDR blocks - covers all private IP ranges
        self.allowed_networks = [
            ipaddress.ip_network("10.0.0.0/8"),      # Private Class A
            ipaddress.ip_network("172.16.0.0/12"),   # Private Class B
            ipaddress.ip_network("192.168.0.0/16"),  # Private Class C
            ipaddress.ip_network("127.0.0.0/8"),     # Localhost
        ]

    def __call__(self, request):
        if request.path.startswith("/health/"):
            # Allow health checks from AWS load balancer (User-Agent check)
            user_agent = request.META.get('HTTP_USER_AGENT', '')
            if 'ELB-HealthChecker' in user_agent:
                return self.get_response(request)
                
            client_ip = self.get_client_ip(request)
            if not self.is_allowed_ip(client_ip):
                return HttpResponseForbidden("Health check access denied - VPC only")

        return self.get_response(request)

    def get_client_ip(self, request):
        """
        Extract the real client IP from request headers.

        When behind a load balancer, the real IP is typically in
        X-Forwarded-For header. Falls back to REMOTE_ADDR.
        """
        x_forwarded_for = request.META.get("HTTP_X_FORWARDED_FOR")
        if x_forwarded_for:
            # Take the first IP (leftmost) which is the original client
            return x_forwarded_for.split(",")[0].strip()
        return request.META.get("REMOTE_ADDR", "")

    def is_allowed_ip(self, ip_str):
        """
        Check if the given IP address is within allowed private networks.
        """
        try:
            ip = ipaddress.ip_address(ip_str)
            return any(ip in network for network in self.allowed_networks)
        except (ValueError, ipaddress.AddressValueError):
            # Invalid IP format - deny access
            return False
