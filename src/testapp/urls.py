from django.urls import path

from .views import health_check, hello_world

urlpatterns = [path("", hello_world), path("health/", health_check)]
