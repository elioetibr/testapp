import os
from unittest.mock import patch

from django.conf import settings
from django.test import Client, TestCase
from django.urls import reverse


class EnvironmentTestCase(TestCase):
    def test_required_setting(self):
        """Test that REQUIRED_SETTING environment variable is set"""
        required_setting = os.getenv("REQUIRED_SETTING", None)
        self.assertIsNotNone(
            required_setting,
            'Environment setting "REQUIRED_SETTING" was not found. '
            "Set REQUIRED_SETTING to any value for this test to pass.",
        )


class ViewTestCase(TestCase):
    def setUp(self):
        self.client = Client()

    def test_hello_world_view(self):
        """Test hello_world view returns correct response"""
        response = self.client.get(reverse("hello_world"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content.decode(), "Hello World")

    def test_health_check_view(self):
        """Test health_check view returns correct response"""
        response = self.client.get(reverse("health_check"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content.decode(), "OK")


class UrlsTestCase(TestCase):
    def test_root_url_resolves_to_hello_world(self):
        """Test root URL resolves to hello_world view"""
        from django.urls import resolve
        view = resolve("/")
        self.assertEqual(view.func.__name__, "hello_world")

    def test_health_url_resolves_to_health_check(self):
        """Test health URL resolves to health_check view"""
        from django.urls import resolve
        view = resolve("/health/")
        self.assertEqual(view.func.__name__, "health_check")


class WSGITestCase(TestCase):
    def test_wsgi_application_import(self):
        """Test WSGI application can be imported"""
        from testapp.wsgi import application
        self.assertIsNotNone(application)

    def test_wsgi_django_setup(self):
        """Test WSGI module sets up Django correctly"""
        with patch("django.setup"), patch("os.environ.setdefault") as mock_setdefault:
            # Import wsgi module to trigger its execution
            import importlib

            import testapp.wsgi
            importlib.reload(testapp.wsgi)

            mock_setdefault.assert_called_with("DJANGO_SETTINGS_MODULE", "testapp.settings")


class ASGITestCase(TestCase):
    def test_asgi_application_import(self):
        """Test ASGI application can be imported"""
        from testapp.asgi import application
        self.assertIsNotNone(application)

    def test_asgi_django_setup(self):
        """Test ASGI module sets up Django correctly"""
        with patch("django.setup"), patch("os.environ.setdefault") as mock_setdefault:
            # Import asgi module to trigger its execution
            import importlib

            import testapp.asgi
            importlib.reload(testapp.asgi)

            mock_setdefault.assert_called_with("DJANGO_SETTINGS_MODULE", "testapp.settings")


class SettingsTestCase(TestCase):
    def test_debug_setting_in_testing(self):
        """Test DEBUG is False in testing environment"""
        self.assertFalse(settings.DEBUG)

    def test_secret_key_is_set(self):
        """Test SECRET_KEY is configured"""
        self.assertIsNotNone(settings.SECRET_KEY)
        self.assertNotEqual(settings.SECRET_KEY, "")

    def test_allowed_hosts_configured(self):
        """Test ALLOWED_HOSTS is configured"""
        self.assertIsInstance(settings.ALLOWED_HOSTS, list)

    def test_installed_apps_configured(self):
        """Test INSTALLED_APPS is configured"""
        self.assertIsInstance(settings.INSTALLED_APPS, list)
        self.assertIn("django.contrib.admin", settings.INSTALLED_APPS)

    def test_middleware_configured(self):
        """Test MIDDLEWARE is configured"""
        self.assertIsInstance(settings.MIDDLEWARE, list)
        self.assertIn("django.middleware.security.SecurityMiddleware", settings.MIDDLEWARE)

    def test_database_configuration(self):
        """Test database configuration"""
        self.assertIn("default", settings.DATABASES)
        self.assertEqual(settings.DATABASES["default"]["ENGINE"], "django.db.backends.sqlite3")

    def test_timezone_setting(self):
        """Test timezone is configured"""
        self.assertEqual(settings.TIME_ZONE, "UTC")

    def test_language_code_setting(self):
        """Test language code is configured"""
        self.assertEqual(settings.LANGUAGE_CODE, "en-us")

    def test_static_url_setting(self):
        """Test static URL is configured"""
        self.assertEqual(settings.STATIC_URL, "/static/")

    def test_logging_configuration(self):
        """Test logging is configured"""
        self.assertIn("version", settings.LOGGING)
        self.assertEqual(settings.LOGGING["version"], 1)
